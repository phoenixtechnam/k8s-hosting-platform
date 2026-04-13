package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"
)

// Config holds all gateway configuration read from environment variables.
type Config struct {
	BackendURL     string
	InternalSecret string
	SSHHostKeyPath string
	SSHPort        string
	FTPSPort       string
	FTPSCertPath   string
	FTPSKeyPath    string
	FTPSPassiveIP  string
	IdleTimeout    time.Duration
	MaxConnections int
	Kubeconfig     string
}

func loadConfig() Config {
	cfg := Config{
		BackendURL:     envOrDefault("BACKEND_URL", "http://backend.platform-system:3000"),
		InternalSecret: os.Getenv("INTERNAL_SECRET"),
		SSHHostKeyPath: envOrDefault("SSH_HOST_KEY_PATH", "/etc/ssh/keys/ssh_host_ed25519_key"),
		SSHPort:        envOrDefault("SSH_PORT", "2222"),
		FTPSPort:       envOrDefault("FTPS_PORT", "2121"),
		FTPSCertPath:   envOrDefault("FTPS_CERT_PATH", "/etc/tls/tls.crt"),
		FTPSKeyPath:    envOrDefault("FTPS_KEY_PATH", "/etc/tls/tls.key"),
		FTPSPassiveIP:  os.Getenv("FTPS_PASSIVE_IP"),
		Kubeconfig:     os.Getenv("KUBECONFIG"),
	}

	idleStr := envOrDefault("IDLE_TIMEOUT", "15m")
	dur, err := time.ParseDuration(idleStr)
	if err != nil {
		log.Fatalf("invalid IDLE_TIMEOUT %q: %v", idleStr, err)
	}
	cfg.IdleTimeout = dur

	maxStr := envOrDefault("MAX_CONNECTIONS", "200")
	maxConn, err := strconv.Atoi(maxStr)
	if err != nil {
		log.Fatalf("invalid MAX_CONNECTIONS %q: %v", maxStr, err)
	}
	cfg.MaxConnections = maxConn

	return cfg
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := loadConfig()

	if cfg.InternalSecret == "" {
		log.Fatal("INTERNAL_SECRET environment variable is required")
	}

	// Initialise shared modules.
	InitAuth(cfg.BackendURL, cfg.InternalSecret)

	if err := InitKube(cfg.Kubeconfig); err != nil {
		log.Fatalf("failed to initialise kubernetes client: %v", err)
	}

	sessionMgr := NewSessionManager(cfg.MaxConnections)

	// --- SSH server -----------------------------------------------------------
	sshServer := buildSSHServer(cfg, sessionMgr)

	// --- Health check HTTP server --------------------------------------------
	healthMux := http.NewServeMux()
	healthMux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	healthServer := &http.Server{
		Addr:              ":8080",
		Handler:           healthMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// --- Graceful shutdown ----------------------------------------------------
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup

	// Start SSH listener.
	wg.Add(1)
	go func() {
		defer wg.Done()
		addr := ":" + cfg.SSHPort
		log.Printf("SSH server listening on %s", addr)
		if err := sshServer.ListenAndServe(); err != nil && err != ssh.ErrServerClosed {
			log.Fatalf("SSH server error: %v", err)
		}
	}()

	// Start optional FTPS listener (only if TLS cert exists).
	if cfg.FTPSPort != "" {
		if _, err := os.Stat(cfg.FTPSCertPath); err == nil {
			wg.Add(1)
			go func() {
				defer wg.Done()
				port, err := strconv.Atoi(cfg.FTPSPort)
				if err != nil {
					log.Fatalf("invalid FTPS_PORT %q: %v", cfg.FTPSPort, err)
				}
				log.Printf("FTPS server listening on :%d", port)
				if err := StartFTPS(port, cfg.FTPSCertPath, cfg.FTPSKeyPath, cfg.FTPSPassiveIP, sessionMgr); err != nil {
					log.Fatalf("FTPS server error: %v", err)
				}
			}()
		} else {
			log.Printf("FTPS disabled: TLS cert not found at %s", cfg.FTPSCertPath)
		}
	}

	// Start health server.
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Println("Health check server listening on :8080")
		if err := healthServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("health server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = sshServer.Shutdown(shutdownCtx)
	_ = healthServer.Shutdown(shutdownCtx)

	wg.Wait()
	log.Println("shutdown complete")
}

// buildSSHServer creates the gliderlabs/ssh server with password and public-key
// authentication, SFTP subsystem handling, and exec handling for SCP/rsync.
func buildSSHServer(cfg Config, sessionMgr *SessionManager) *ssh.Server {
	server := &ssh.Server{
		Addr:        ":" + cfg.SSHPort,
		IdleTimeout: cfg.IdleTimeout,
		MaxTimeout:  4 * time.Hour,

		// Password authentication.
		PasswordHandler: func(ctx ssh.Context, password string) bool {
			ip := remoteIP(ctx.RemoteAddr().String())
			result, err := AuthenticatePassword(ctx.User(), password, ip)
			if err != nil {
				log.Printf("auth error for %s@%s: %v", ctx.User(), ip, err)
				go func() {
					_ = ReportAuditEvent(AuditEvent{
						ClientID:     "",
						Event:        "FAILED_AUTH",
						SourceIP:     ip,
						Protocol:     "ssh",
						ErrorMessage: fmt.Sprintf("password auth error for %s: %v", ctx.User(), err),
					})
				}()
				return false
			}
			if !result.Allowed {
				log.Printf("auth rejected for %s@%s", ctx.User(), ip)
				go func() {
					_ = ReportAuditEvent(AuditEvent{
						SftpUserID: result.SftpUserID,
						ClientID:   result.ClientID,
						Event:      "FAILED_AUTH",
						SourceIP:   ip,
						Protocol:   "ssh",
						ErrorMessage: fmt.Sprintf("password auth rejected for %s", ctx.User()),
					})
				}()
				return false
			}
			ctx.SetValue(authResultKey, result)
			return true
		},

		// Public-key authentication.
		PublicKeyHandler: func(ctx ssh.Context, key ssh.PublicKey) bool {
			ip := remoteIP(ctx.RemoteAddr().String())
			fingerprint := gossh.FingerprintSHA256(key)
			result, err := AuthenticateKey(ctx.User(), fingerprint, ip)
			if err != nil {
				log.Printf("key auth error for %s@%s: %v", ctx.User(), ip, err)
				go func() {
					_ = ReportAuditEvent(AuditEvent{
						ClientID:     "",
						Event:        "FAILED_AUTH",
						SourceIP:     ip,
						Protocol:     "ssh",
						ErrorMessage: fmt.Sprintf("key auth error for %s: %v", ctx.User(), err),
					})
				}()
				return false
			}
			if !result.Allowed {
				log.Printf("key auth rejected for %s@%s", ctx.User(), ip)
				go func() {
					_ = ReportAuditEvent(AuditEvent{
						SftpUserID: result.SftpUserID,
						ClientID:   result.ClientID,
						Event:      "FAILED_AUTH",
						SourceIP:   ip,
						Protocol:   "ssh",
						ErrorMessage: fmt.Sprintf("key auth rejected for %s", ctx.User()),
					})
				}()
				return false
			}
			ctx.SetValue(authResultKey, result)
			return true
		},

		// SFTP subsystem handler.
		SubsystemHandlers: map[string]ssh.SubsystemHandler{
			"sftp": func(sess ssh.Session) {
				sessionMgr.HandleSession(sess, "sftp", nil)
			},
		},
	}

	// Exec handler for SCP and rsync (and generic exec).
	server.Handler = func(sess ssh.Session) {
		rawCmd := sess.RawCommand()
		if rawCmd == "" {
			fmt.Fprintln(sess, "interactive shell not supported — use SFTP, SCP, or rsync")
			_ = sess.Exit(1)
			return
		}
		sessionMgr.HandleSession(sess, "exec", &rawCmd)
	}

	// Load host key.
	if err := loadHostKey(server, cfg.SSHHostKeyPath); err != nil {
		log.Fatalf("failed to load SSH host key from %s: %v", cfg.SSHHostKeyPath, err)
	}

	return server
}

func loadHostKey(server *ssh.Server, path string) error {
	keyBytes, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read host key: %w", err)
	}
	signer, err := gossh.ParsePrivateKey(keyBytes)
	if err != nil {
		return fmt.Errorf("parse host key: %w", err)
	}
	server.AddHostKey(signer)
	return nil
}

// authResultKey is the context key for storing *AuthResult after authentication.
type ctxKey string

const authResultKey ctxKey = "auth_result"

// remoteIP strips the port from a host:port address.
// Uses net.SplitHostPort which handles both IPv4 and IPv6 (e.g. [::1]:22).
func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
