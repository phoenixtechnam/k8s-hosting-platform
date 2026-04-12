package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gliderlabs/ssh"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Session represents an active SSH/SFTP/SCP/rsync session.
type Session struct {
	ID                    string
	Username              string
	SftpUserID            string
	ClientID              string
	Namespace             string
	Protocol              string // "sftp", "scp", "rsync", "exec"
	SourceIP              string
	StartTime             time.Time
	HomePath              string
	AllowWrite            bool
	MaxConcurrentSessions int
}

// SessionManager tracks active sessions and enforces concurrency limits.
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	byUser   map[string]int
	total    int
	maxTotal int
}

// NewSessionManager creates a SessionManager with the given total connection cap.
func NewSessionManager(maxTotal int) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		byUser:   make(map[string]int),
		maxTotal: maxTotal,
	}
}

// ---- session bookkeeping ---------------------------------------------------

func (m *SessionManager) register(sess *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.total >= m.maxTotal {
		return fmt.Errorf("max total connections (%d) reached", m.maxTotal)
	}

	// Per-user cap: use the limit from the database (via auth response), default 3.
	perUserMax := sess.MaxConcurrentSessions
	if perUserMax <= 0 {
		perUserMax = 3
	}
	if m.byUser[sess.Username] >= perUserMax {
		return fmt.Errorf("max per-user connections (%d) reached for %s", perUserMax, sess.Username)
	}

	m.sessions[sess.ID] = sess
	m.byUser[sess.Username]++
	m.total++
	return nil
}

func (m *SessionManager) unregister(id, username string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.sessions[id]; ok {
		delete(m.sessions, id)
		m.byUser[username]--
		if m.byUser[username] <= 0 {
			delete(m.byUser, username)
		}
		m.total--
	}
}

// ---- main handler ----------------------------------------------------------

// HandleSession is the unified session handler for SFTP subsystem requests and
// exec requests (SCP / rsync / generic).
// If rawCmd is nil the request is an SFTP subsystem; otherwise it is an exec.
func (m *SessionManager) HandleSession(sshSess ssh.Session, protocol string, rawCmd *string) {
	authResult, ok := sshSess.Context().Value(authResultKey).(*AuthResult)
	if !ok || authResult == nil {
		log.Println("session: missing auth result")
		_ = sshSess.Exit(1)
		return
	}

	sourceIP := remoteIP(sshSess.RemoteAddr().String())

	// Determine protocol from raw command if this is an exec request.
	if rawCmd != nil {
		protocol = classifyCommand(*rawCmd)
	}

	sess := &Session{
		ID:                    fmt.Sprintf("%s-%d", authResult.ClientID, time.Now().UnixNano()),
		Username:              sshSess.User(),
		SftpUserID:            authResult.SftpUserID,
		ClientID:              authResult.ClientID,
		Namespace:             authResult.Namespace,
		Protocol:              protocol,
		SourceIP:              sourceIP,
		StartTime:             time.Now(),
		HomePath:              authResult.HomePath,
		AllowWrite:            authResult.AllowWrite,
		MaxConcurrentSessions: authResult.MaxConcurrentSessions,
	}

	if err := m.register(sess); err != nil {
		log.Printf("session: registration failed: %v", err)
		fmt.Fprintf(sshSess.Stderr(), "connection limit exceeded\n")
		_ = sshSess.Exit(1)
		return
	}
	defer m.unregister(sess.ID, sess.Username)

	log.Printf("session %s: %s %s@%s namespace=%s", sess.ID, sess.Protocol, sess.Username, sourceIP, sess.Namespace)

	// Report CONNECT audit event (best-effort).
	go func() {
		_ = ReportAuditEvent(AuditEvent{
			SftpUserID: sess.SftpUserID,
			ClientID:   sess.ClientID,
			Event:      "CONNECT",
			SourceIP:   sourceIP,
			Protocol:   sess.Protocol,
			SessionID:  sess.ID,
		})
	}()

	// Ensure file-manager pod is running.
	podName, err := resolveFileManagerPod(sess.Namespace)
	if err != nil {
		log.Printf("session %s: pod resolution failed: %v", sess.ID, err)
		fmt.Fprintf(sshSess.Stderr(), "failed to prepare file system: %v\n", err)
		_ = sshSess.Exit(1)
		return
	}

	// Build exec command.
	command := buildCommand(protocol, rawCmd, authResult.HomePath)
	if command == nil {
		log.Printf("session %s: rejected unsupported command: %s", sess.ID, protocol)
		fmt.Fprintf(sshSess.Stderr(), "unsupported command — only SFTP, SCP, and rsync are allowed\n")
		_ = sshSess.Exit(1)
		return
	}

	log.Printf("session %s: exec in pod %s/%s: %v", sess.ID, sess.Namespace, podName, command)

	// Execute bidirectional pipe into the pod.
	exitCode := execAndPipe(sshSess, sess.Namespace, podName, command)

	// Report audit event (best-effort).
	duration := time.Since(sess.StartTime)
	go func() {
		_ = ReportAuditEvent(AuditEvent{
			SftpUserID:      sess.SftpUserID,
			ClientID:        sess.ClientID,
			Event:           "DISCONNECT",
			SourceIP:        sourceIP,
			Protocol:        sess.Protocol,
			SessionID:       sess.ID,
			DurationSeconds: int(duration.Seconds()),
		})
	}()

	_ = sshSess.Exit(exitCode)
}

// ---- helpers ---------------------------------------------------------------

// classifyCommand determines the protocol from a raw exec command string.
func classifyCommand(cmd string) string {
	trimmed := strings.TrimSpace(cmd)
	switch {
	case strings.HasPrefix(trimmed, "scp "):
		return "scp"
	case strings.HasPrefix(trimmed, "rsync "):
		return "rsync"
	default:
		return "exec"
	}
}

// buildCommand returns the command slice to exec in the file-manager pod.
// SFTP uses chroot to /data so all file operations (including absolute paths)
// are confined to the PVC. SCP and rsync use path rewriting instead because
// their command arguments are fully controlled by the gateway.
func buildCommand(protocol string, rawCmd *string, homePath string) []string {
	dataRoot := filepath.Clean("/data/" + strings.TrimPrefix(homePath, "/"))

	switch protocol {
	case "sftp":
		// Chroot to /data — sftp-server sees / as the PVC root.
		// The patched binary at /.platform/sftp-server has its ELF interpreter
		// and rpath set to /.platform/sftp-jail/lib/ so it runs inside the chroot
		// without needing /lib/ at the chroot root.
		chrootHome := filepath.Clean("/" + strings.TrimPrefix(homePath, "/"))
		return []string{"chroot", "/data", "/.platform/sftp-server", "-e", "-d", chrootHome}
	case "scp":
		if rawCmd != nil {
			return rewriteSCPCommand(*rawCmd, dataRoot)
		}
		return []string{"/usr/lib/ssh/sftp-server", "-e", "-d", dataRoot}
	case "rsync":
		if rawCmd != nil {
			return rewriteRsyncCommand(*rawCmd, dataRoot)
		}
		return []string{"/usr/lib/ssh/sftp-server", "-e", "-d", dataRoot}
	default:
		// Reject unrecognised commands — only sftp/scp/rsync are allowed.
		return nil
	}
}

// sanitizePath cleans a path argument and confines it under dataRoot.
// Returns dataRoot if the path would escape or contains null bytes.
func sanitizePath(arg, dataRoot string) string {
	if strings.ContainsRune(arg, 0) {
		return dataRoot
	}
	clean := filepath.Clean("/" + arg)
	joined := filepath.Clean(dataRoot + clean)
	if !strings.HasPrefix(joined, dataRoot+"/") && joined != dataRoot {
		return dataRoot
	}
	return joined
}

// rewriteSCPCommand rewrites scp path arguments to be under dataRoot.
// scp commands look like: scp -t /some/path or scp -f /some/path
func rewriteSCPCommand(cmd, dataRoot string) []string {
	parts := strings.Fields(cmd)
	rewritten := make([]string, len(parts))
	copy(rewritten, parts)

	for i := 1; i < len(rewritten); i++ {
		arg := rewritten[i]
		// Skip flags.
		if strings.HasPrefix(arg, "-") {
			continue
		}
		rewritten[i] = sanitizePath(arg, dataRoot)
	}
	return rewritten
}

// rewriteRsyncCommand rewrites rsync paths. rsync over SSH sends the rsync
// binary path and arguments; we prefix path arguments with dataRoot.
// Typical: rsync --server -logDtpre.iLsfxCIvu . /some/path
func rewriteRsyncCommand(cmd, dataRoot string) []string {
	parts := strings.Fields(cmd)
	rewritten := make([]string, len(parts))
	copy(rewritten, parts)

	// The last argument(s) of an rsync --server command are paths.
	// A "." argument separates options from paths.
	dotSeen := false
	for i := 1; i < len(rewritten); i++ {
		arg := rewritten[i]
		if arg == "." {
			dotSeen = true
			continue
		}
		if !dotSeen {
			continue
		}
		// After ".", everything is a path — sanitize to prevent traversal.
		rewritten[i] = sanitizePath(arg, dataRoot)
	}
	return rewritten
}

// resolveFileManagerPod ensures the file-manager is running and finds its pod.
func resolveFileManagerPod(namespace string) (string, error) {
	// First ask the backend to ensure the pod is ready.
	podName, err := EnsureFileManager(namespace)
	if err != nil {
		log.Printf("ensure-file-manager call failed: %v, falling back to direct pod lookup", err)
	}
	if podName != "" {
		return podName, nil
	}

	// Fallback: list pods with label selector.
	return findFileManagerPod(namespace)
}

// findFileManagerPod searches for a running file-manager pod in the namespace.
func findFileManagerPod(namespace string) (string, error) {
	pods, err := kubeClientset.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: "app=file-manager",
		Limit:         1,
	})
	if err != nil {
		return "", fmt.Errorf("list file-manager pods: %w", err)
	}
	if len(pods.Items) == 0 {
		return "", fmt.Errorf("no file-manager pod found in namespace %s", namespace)
	}

	pod := pods.Items[0]
	if pod.Status.Phase != "Running" {
		return "", fmt.Errorf("file-manager pod %s is %s, not Running", pod.Name, pod.Status.Phase)
	}
	return pod.Name, nil
}

// execAndPipe runs a command in the file-manager pod and pipes stdin/stdout/stderr
// bidirectionally to/from the SSH session. Returns the exit code.
func execAndPipe(sshSess ssh.Session, namespace, podName string, command []string) int {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()

	var wg sync.WaitGroup

	// Goroutine: SSH session -> exec stdin.
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer stdinWriter.Close()
		_, _ = io.Copy(stdinWriter, sshSess)
	}()

	// Goroutine: exec stdout -> SSH session.
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer stdoutReader.Close()
		_, _ = io.Copy(sshSess, stdoutReader)
	}()

	// Run exec (blocking).
	err := ExecInPod(namespace, podName, "file-manager", command, stdinReader, stdoutWriter, sshSess.Stderr())

	// Close the writer side so the stdout goroutine finishes.
	stdoutWriter.Close()
	stdinReader.Close()

	wg.Wait()

	if err != nil {
		log.Printf("exec error: %v", err)
		return 1
	}
	return 0
}
