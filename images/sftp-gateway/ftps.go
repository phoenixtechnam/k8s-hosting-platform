package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	ftpserver "goftp.io/server/v2"
)

// StartFTPS starts the FTPS server on the given port. It blocks until the
// server exits. If certPath/keyPath are invalid or missing it returns an error.
func StartFTPS(port int, certPath, keyPath string, sessionMgr *SessionManager) error {
	driver := &ftpsDriver{sessionMgr: sessionMgr}

	opts := &ftpserver.Options{
		Name:         "k8s-sftp-gateway",
		Port:         port,
		TLS:          true,
		CertFile:     certPath,
		KeyFile:      keyPath,
		ExplicitFTPS: true,
		ForceTLS:     true,
		PassivePorts: "30000-30099",
		Driver:       driver,
		Auth:         &ftpsAuth{sessionMgr: sessionMgr},
		Perm:         ftpserver.NewSimplePerm("owner", "group"),
	}

	server, err := ftpserver.NewServer(opts)
	if err != nil {
		return fmt.Errorf("create FTPS server: %w", err)
	}

	return server.ListenAndServe()
}

// ---- FTP authentication ----------------------------------------------------

// authResultDataKey is the key used to store *AuthResult in the Session.Data map.
const authResultDataKey = "auth_result"

type ftpsAuth struct {
	sessionMgr *SessionManager
}

func (a *ftpsAuth) CheckPasswd(ctx *ftpserver.Context, username, password string) (bool, error) {
	sourceIP := "unknown"
	if ctx.Sess != nil && ctx.Sess.RemoteAddr() != nil {
		sourceIP = remoteIP(ctx.Sess.RemoteAddr().String())
	}

	result, err := AuthenticatePassword(username, password, sourceIP)
	if err != nil {
		log.Printf("FTPS auth error for %s: %v", username, err)
		go func() {
			_ = ReportAuditEvent(AuditEvent{
				Event:        "FAILED_AUTH",
				SourceIP:     sourceIP,
				Protocol:     "ftps",
				ErrorMessage: fmt.Sprintf("FTPS auth error for %s: %v", username, err),
			})
		}()
		return false, nil
	}
	if !result.Allowed {
		go func() {
			_ = ReportAuditEvent(AuditEvent{
				SftpUserID:   result.SftpUserID,
				ClientID:     result.ClientID,
				Event:        "FAILED_AUTH",
				SourceIP:     sourceIP,
				Protocol:     "ftps",
				ErrorMessage: fmt.Sprintf("FTPS auth rejected for %s", username),
			})
		}()
		return false, nil
	}

	// Stash the auth result in the session's shared data map.
	// This write is safe because CheckPasswd is called once per session before
	// any driver methods run — no concurrent access at this point.
	if ctx.Sess != nil {
		ctx.Sess.Data[authResultDataKey] = result
	}

	// Register FTPS session for concurrency tracking.
	ftpsSessID := make([]byte, 16)
	rand.Read(ftpsSessID)
	sess := &Session{
		ID:                    fmt.Sprintf("%x", ftpsSessID),
		Username:              username,
		SftpUserID:            result.SftpUserID,
		ClientID:              result.ClientID,
		Namespace:             result.Namespace,
		Protocol:              "ftps",
		SourceIP:              sourceIP,
		StartTime:             time.Now(),
		HomePath:              result.HomePath,
		AllowWrite:            result.AllowWrite,
		MaxConcurrentSessions: result.MaxConcurrentSessions,
	}
	if err := a.sessionMgr.register(sess); err != nil {
		log.Printf("FTPS session registration failed: %v", err)
		fmt.Fprintf(log.Writer(), "FTPS connection limit exceeded for %s\n", username)
		return false, nil
	}

	// Store session ID for cleanup on disconnect.
	if ctx.Sess != nil {
		ctx.Sess.Data["ftps_session_id"] = sess.ID
		ctx.Sess.Data["ftps_username"] = username
	}

	// Emit CONNECT audit event.
	go func() {
		_ = ReportAuditEvent(AuditEvent{
			SftpUserID: sess.SftpUserID,
			ClientID:   sess.ClientID,
			Event:      "CONNECT",
			SourceIP:   sourceIP,
			Protocol:   "ftps",
			SessionID:  sess.ID,
		})
	}()

	return true, nil
}

// ---- FTP driver (shared across all connections) ----------------------------

// ftpsDriver implements goftp.Driver by translating FTP operations to K8s exec
// commands inside the file-manager pod. Each method receives the Context which
// carries the session, from which we retrieve the AuthResult.
// podCache is a sync.Map keyed by session RemoteAddr to avoid data races on
// the non-goroutine-safe ctx.Sess.Data map.
type ftpsDriver struct {
	sessionMgr *SessionManager
	podCache   sync.Map // map[string]string — remoteAddr → podName
}

// getSessionState extracts the AuthResult from the FTP context and resolves the
// pod name and data root for this connection. Pod name is cached in a sync.Map
// (not ctx.Sess.Data) to avoid data races from concurrent FTP commands.
func (d *ftpsDriver) getSessionState(ctx *ftpserver.Context) (*AuthResult, string, string, error) {
	if ctx.Sess == nil {
		return nil, "", "", errors.New("no FTP session")
	}

	raw, ok := ctx.Sess.Data[authResultDataKey]
	if !ok {
		return nil, "", "", errors.New("not authenticated")
	}
	ar, ok := raw.(*AuthResult)
	if !ok {
		return nil, "", "", errors.New("invalid auth result in session")
	}

	dataRoot := filepath.Clean("/data/" + strings.TrimPrefix(ar.HomePath, "/"))

	// Cache key: use remote address to identify the session.
	cacheKey := ""
	if ctx.Sess.RemoteAddr() != nil {
		cacheKey = ctx.Sess.RemoteAddr().String()
	}

	// Check if pod name is already cached (thread-safe).
	if cacheKey != "" {
		if cached, exists := d.podCache.Load(cacheKey); exists {
			if podName, ok := cached.(string); ok && podName != "" {
				return ar, podName, dataRoot, nil
			}
		}
	}

	// Resolve pod.
	podName, err := resolveFileManagerPod(ar.Namespace)
	if err != nil {
		return nil, "", "", fmt.Errorf("resolve file-manager pod: %w", err)
	}

	// Cache it (thread-safe).
	if cacheKey != "" {
		d.podCache.Store(cacheKey, podName)
	}

	return ar, podName, dataRoot, nil
}

func (d *ftpsDriver) Stat(ctx *ftpserver.Context, path string) (os.FileInfo, error) {
	_, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return nil, err
	}

	fullPath := joinDataPath(dataRoot, path)
	out, err := execCommandInPod(ctx, podName, []string{"stat", "-c", "%s %Y %F %n", fullPath})
	if err != nil {
		return nil, os.ErrNotExist
	}

	return parseStatOutput(strings.TrimSpace(out), path)
}

func (d *ftpsDriver) ListDir(ctx *ftpserver.Context, path string, callback func(os.FileInfo) error) error {
	_, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return err
	}

	fullPath := joinDataPath(dataRoot, path)
	out, err := execCommandInPod(ctx, podName, []string{"ls", "-1a", fullPath})
	if err != nil {
		return fmt.Errorf("list directory: %w", err)
	}

	lines := strings.Split(strings.TrimSpace(out), "\n")
	for _, name := range lines {
		name = strings.TrimSpace(name)
		if name == "" || name == "." || name == ".." {
			continue
		}
		entryPath := fullPath + "/" + name
		statOut, serr := execCommandInPod(ctx, podName, []string{"stat", "-c", "%s %Y %F %n", entryPath})
		if serr != nil {
			continue
		}
		fi, perr := parseStatOutput(strings.TrimSpace(statOut), name)
		if perr != nil {
			continue
		}
		if err := callback(fi); err != nil {
			return err
		}
	}
	return nil
}

func (d *ftpsDriver) GetFile(ctx *ftpserver.Context, path string, offset int64) (int64, io.ReadCloser, error) {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return 0, nil, err
	}

	fullPath := joinDataPath(dataRoot, path)

	// Get file size.
	sizeOut, err := execCommandInPod(ctx, podName, []string{"stat", "-c", "%s", fullPath})
	if err != nil {
		return 0, nil, os.ErrNotExist
	}
	size, _ := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)

	// Stream the file via cat (or dd for offset).
	var cmd []string
	if offset > 0 {
		cmd = []string{"dd", fmt.Sprintf("if=%s", fullPath), "bs=4096",
			fmt.Sprintf("skip=%d", offset), "iflag=skip_bytes"}
	} else {
		cmd = []string{"cat", fullPath}
	}

	pr, pw := io.Pipe()
	go func() {
		execErr := ExecInPod(ar.Namespace, podName, "file-manager", cmd, nil, pw, io.Discard)
		pw.CloseWithError(execErr)
	}()

	return size - offset, pr, nil
}

func (d *ftpsDriver) PutFile(ctx *ftpserver.Context, path string, data io.Reader, offset int64) (int64, error) {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return 0, err
	}
	if !ar.AllowWrite {
		return 0, errors.New("write permission denied")
	}

	fullPath := joinDataPath(dataRoot, path)

	var cmd []string
	if offset > 0 {
		cmd = []string{"dd", fmt.Sprintf("of=%s", fullPath), "bs=4096",
			fmt.Sprintf("seek=%d", offset), "oflag=seek_bytes"}
	} else {
		cmd = []string{"dd", fmt.Sprintf("of=%s", fullPath)}
	}

	cr := &countingReader{r: data}
	execErr := ExecInPod(ar.Namespace, podName, "file-manager", cmd, cr, io.Discard, io.Discard)
	if execErr != nil {
		return cr.n, fmt.Errorf("put file: %w", execErr)
	}
	return cr.n, nil
}

func (d *ftpsDriver) DeleteFile(ctx *ftpserver.Context, path string) error {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return err
	}
	if !ar.AllowDelete {
		return errors.New("delete permission denied")
	}

	fullPath := joinDataPath(dataRoot, path)
	_, err = execCommandInPod(ctx, podName, []string{"rm", fullPath})
	return err
}

func (d *ftpsDriver) DeleteDir(ctx *ftpserver.Context, path string) error {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return err
	}
	if !ar.AllowDelete {
		return errors.New("delete permission denied")
	}

	fullPath := joinDataPath(dataRoot, path)
	_, err = execCommandInPod(ctx, podName, []string{"rmdir", fullPath})
	return err
}

func (d *ftpsDriver) MakeDir(ctx *ftpserver.Context, path string) error {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return err
	}
	if !ar.AllowWrite {
		return errors.New("write permission denied")
	}

	fullPath := joinDataPath(dataRoot, path)
	_, err = execCommandInPod(ctx, podName, []string{"mkdir", "-p", fullPath})
	return err
}

func (d *ftpsDriver) Rename(ctx *ftpserver.Context, oldPath, newPath string) error {
	ar, podName, dataRoot, err := d.getSessionState(ctx)
	if err != nil {
		return err
	}
	if !ar.AllowWrite {
		return errors.New("write permission denied")
	}

	oldFull := joinDataPath(dataRoot, oldPath)
	newFull := joinDataPath(dataRoot, newPath)
	_, err = execCommandInPod(ctx, podName, []string{"mv", oldFull, newFull})
	return err
}

// ---- session cleanup (Notifier interface) -----------------------------------

// BeforeLogout is called by the goftp server when a session ends.
// We use it to unregister the FTPS session and emit a DISCONNECT audit event.
func (d *ftpsDriver) BeforeLogout(ctx *ftpserver.Context) error {
	if ctx.Sess == nil {
		return nil
	}

	// Read session tracking data (written once during CheckPasswd, safe to read).
	sessIDRaw, ok := ctx.Sess.Data["ftps_session_id"]
	if !ok {
		return nil
	}
	sessID, _ := sessIDRaw.(string)
	usernameRaw, _ := ctx.Sess.Data["ftps_username"]
	username, _ := usernameRaw.(string)

	// Unregister from session manager.
	d.sessionMgr.unregister(sessID, username)

	// Clean up pod cache.
	if ctx.Sess.RemoteAddr() != nil {
		d.podCache.Delete(ctx.Sess.RemoteAddr().String())
	}

	// Read auth result for audit event.
	arRaw, _ := ctx.Sess.Data[authResultDataKey]
	ar, _ := arRaw.(*AuthResult)

	sourceIP := "unknown"
	if ctx.Sess.RemoteAddr() != nil {
		sourceIP = remoteIP(ctx.Sess.RemoteAddr().String())
	}

	if ar != nil {
		go func() {
			_ = ReportAuditEvent(AuditEvent{
				SftpUserID: ar.SftpUserID,
				ClientID:   ar.ClientID,
				Event:      "DISCONNECT",
				SourceIP:   sourceIP,
				Protocol:   "ftps",
				SessionID:  sessID,
			})
		}()
	}

	return nil
}

// ---- internal helpers ------------------------------------------------------

// joinDataPath constructs the full path under dataRoot for a given FTP path.
// It canonicalises the path and rejects any traversal above dataRoot.
func joinDataPath(dataRoot, path string) string {
	// Reject null bytes which can terminate C strings in shell commands.
	if strings.ContainsRune(path, 0) {
		return dataRoot
	}
	clean := filepath.Clean("/" + path)
	if clean == "/" {
		return dataRoot
	}
	joined := filepath.Clean(dataRoot + clean)
	// Ensure the result is still under dataRoot.
	if !strings.HasPrefix(joined, dataRoot+"/") && joined != dataRoot {
		return dataRoot
	}
	return joined
}

// execCommandInPod runs a command in the file-manager pod and returns stdout.
// It extracts the namespace from the session's AuthResult.
func execCommandInPod(ctx *ftpserver.Context, podName string, command []string) (string, error) {
	raw, ok := ctx.Sess.Data[authResultDataKey]
	if !ok {
		return "", errors.New("not authenticated")
	}
	ar := raw.(*AuthResult)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	err := ExecInPod(ar.Namespace, podName, "file-manager", command, nil, &stdout, &stderr)
	if err != nil {
		return "", fmt.Errorf("exec %v: %w (stderr: %s)", command, err, stderr.String())
	}
	return stdout.String(), nil
}

// ---- stat parsing ----------------------------------------------------------

// ftpFileInfo implements os.FileInfo for FTP directory listings.
type ftpFileInfo struct {
	name    string
	size    int64
	modTime time.Time
	isDir   bool
}

func (fi *ftpFileInfo) Name() string      { return fi.name }
func (fi *ftpFileInfo) Size() int64        { return fi.size }
func (fi *ftpFileInfo) Mode() os.FileMode {
	if fi.isDir {
		return os.ModeDir | 0755
	}
	return 0644
}
func (fi *ftpFileInfo) ModTime() time.Time { return fi.modTime }
func (fi *ftpFileInfo) IsDir() bool        { return fi.isDir }
func (fi *ftpFileInfo) Sys() interface{}   { return nil }

// parseStatOutput parses the output of stat -c '%s %Y %F %n'.
// Format: <size> <mtime_epoch> <type> <name>
func parseStatOutput(line, fallbackName string) (*ftpFileInfo, error) {
	parts := strings.SplitN(line, " ", 4)
	if len(parts) < 3 {
		return nil, fmt.Errorf("unexpected stat output: %q", line)
	}

	size, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		size = 0
	}

	mtime, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		mtime = 0
	}

	fileType := parts[2]
	isDir := strings.Contains(fileType, "directory")

	name := fallbackName
	if len(parts) >= 4 {
		statName := parts[3]
		if idx := strings.LastIndex(statName, "/"); idx >= 0 {
			statName = statName[idx+1:]
		}
		if statName != "" {
			name = statName
		}
	}

	return &ftpFileInfo{
		name:    name,
		size:    size,
		modTime: time.Unix(mtime, 0),
		isDir:   isDir,
	}, nil
}

// ---- counting reader -------------------------------------------------------

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
