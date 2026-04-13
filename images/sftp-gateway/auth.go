package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// AuthResult is the response from the backend auth endpoints.
type AuthResult struct {
	Allowed              bool   `json:"allowed"`
	SftpUserID           string `json:"sftp_user_id"`
	ClientID             string `json:"client_id"`
	Namespace            string `json:"namespace"`
	HomePath             string `json:"home_path"`
	AllowWrite           bool   `json:"allow_write"`
	AllowDelete          bool   `json:"allow_delete"`
	MaxConcurrentSessions int   `json:"max_concurrent_sessions"`
}

// AuditEvent represents a session audit log entry sent to the backend.
type AuditEvent struct {
	SftpUserID       string `json:"sftp_user_id,omitempty"`
	ClientID         string `json:"client_id"`
	Event            string `json:"event"`
	SourceIP         string `json:"source_ip"`
	Protocol         string `json:"protocol"`
	SessionID        string `json:"session_id,omitempty"`
	DurationSeconds  int    `json:"duration_seconds,omitempty"`
	BytesTransferred int64  `json:"bytes_transferred,omitempty"`
	ErrorMessage     string `json:"error_message,omitempty"`
}

// ---- module-level state (initialised via InitAuth) -------------------------

var (
	backendURL     string
	internalSecret string
	httpClient     *http.Client

	// Rate limiting: track failed auth attempts per IP AND per username.
	rateLimiterIP       rateLimitStore
	rateLimiterUsername rateLimitStore
)

const (
	rateLimitWindow          = 5 * time.Minute
	rateLimitMaxFailsIP      = 5  // per source IP
	rateLimitMaxFailsUser    = 10 // per username (higher — shared NAT users)
)

// rateLimitEntry tracks failures for a single IP.
type rateLimitEntry struct {
	count     int
	firstFail time.Time
}

type rateLimitStore struct {
	mu      sync.Mutex
	entries map[string]*rateLimitEntry
}

// InitAuth sets up the authentication module.
func InitAuth(url, secret string) {
	backendURL = url
	internalSecret = secret
	httpClient = &http.Client{Timeout: 10 * time.Second}
	rateLimiterIP = rateLimitStore{entries: make(map[string]*rateLimitEntry)}
	rateLimiterUsername = rateLimitStore{entries: make(map[string]*rateLimitEntry)}

	// Background goroutine to evict stale rate-limit entries.
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rateLimiterIP.cleanup()
			rateLimiterUsername.cleanup()
		}
	}()
}

// ---- rate limiter ----------------------------------------------------------

func (r *rateLimitStore) isBlockedAt(key string, maxFails int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[key]
	if !ok {
		return false
	}
	if time.Since(entry.firstFail) > rateLimitWindow {
		delete(r.entries, key)
		return false
	}
	return entry.count >= maxFails
}

func (r *rateLimitStore) isBlocked(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[ip]
	if !ok {
		return false
	}
	if time.Since(entry.firstFail) > rateLimitWindow {
		delete(r.entries, ip)
		return false
	}
	return entry.count >= rateLimitMaxFailsIP
}

func (r *rateLimitStore) recordFailure(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[ip]
	if !ok || time.Since(entry.firstFail) > rateLimitWindow {
		r.entries[ip] = &rateLimitEntry{count: 1, firstFail: time.Now()}
		return
	}
	entry.count++
}

func (r *rateLimitStore) resetIP(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, ip)
}

func (r *rateLimitStore) cleanup() {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for ip, entry := range r.entries {
		if now.Sub(entry.firstFail) > rateLimitWindow {
			delete(r.entries, ip)
		}
	}
}

// ---- public functions ------------------------------------------------------

// AuthenticatePassword authenticates a user with username + password.
func AuthenticatePassword(username, password, sourceIP string) (*AuthResult, error) {
	if rateLimiterIP.isBlocked(sourceIP) || rateLimiterUsername.isBlockedAt(username, rateLimitMaxFailsUser) {
		return &AuthResult{Allowed: false}, nil
	}

	body := map[string]string{
		"username":  username,
		"password":  password,
		"source_ip": sourceIP,
	}

	result, err := callAuthEndpoint("/api/v1/internal/sftp/auth", body)
	if err != nil {
		rateLimiterIP.recordFailure(sourceIP)
		rateLimiterUsername.recordFailure(username)
		return nil, err
	}
	if !result.Allowed {
		rateLimiterIP.recordFailure(sourceIP)
		rateLimiterUsername.recordFailure(username)
	} else {
		rateLimiterIP.resetIP(sourceIP)
		rateLimiterUsername.resetIP(username)
		go UpdateLogin(username, sourceIP)
	}
	return result, nil
}

// AuthenticateKey authenticates a user with an SSH public key fingerprint.
func AuthenticateKey(username, keyFingerprint, sourceIP string) (*AuthResult, error) {
	if rateLimiterIP.isBlocked(sourceIP) || rateLimiterUsername.isBlockedAt(username, rateLimitMaxFailsUser) {
		return &AuthResult{Allowed: false}, nil
	}

	body := map[string]string{
		"username":               username,
		"public_key_fingerprint": keyFingerprint,
		"source_ip":              sourceIP,
	}

	result, err := callAuthEndpoint("/api/v1/internal/sftp/auth-key", body)
	if err != nil {
		rateLimiterIP.recordFailure(sourceIP)
		rateLimiterUsername.recordFailure(username)
		return nil, err
	}
	if !result.Allowed {
		rateLimiterIP.recordFailure(sourceIP)
		rateLimiterUsername.recordFailure(username)
	} else {
		rateLimiterIP.resetIP(sourceIP)
		rateLimiterUsername.resetIP(username)
		go UpdateLogin(username, sourceIP)
	}
	return result, nil
}

// EnsureFileManager calls the backend to ensure a file-manager pod is running
// in the given namespace and returns the pod name.
func EnsureFileManager(namespace string) (string, error) {
	body := map[string]string{"namespace": namespace}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal ensure-file-manager request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, backendURL+"/api/v1/internal/sftp/ensure-file-manager", bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("create ensure-file-manager request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Auth", internalSecret)

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("ensure-file-manager request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ensure-file-manager returned status %d", resp.StatusCode)
	}

	var result struct {
		Data struct {
			PodName string `json:"pod_name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode ensure-file-manager response: %w", err)
	}
	return result.Data.PodName, nil
}

// ReportAuditEvent sends one or more audit events to the backend.
func ReportAuditEvent(events ...AuditEvent) error {
	body := map[string][]AuditEvent{"events": events}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal audit event: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, backendURL+"/api/v1/internal/sftp/audit", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create audit request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Auth", internalSecret)

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("audit request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("audit endpoint returned status %d", resp.StatusCode)
	}
	return nil
}

// UpdateLogin fires-and-forgets a login timestamp update to the backend.
func UpdateLogin(username, sourceIP string) {
	body := map[string]string{
		"username":  username,
		"source_ip": sourceIP,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		log.Printf("update-login marshal error: %v", err)
		return
	}

	req, err := http.NewRequest(http.MethodPost, backendURL+"/api/v1/internal/sftp/update-login", bytes.NewReader(payload))
	if err != nil {
		log.Printf("update-login request creation error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Auth", internalSecret)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("update-login request error: %v", err)
		return
	}
	resp.Body.Close()
}

// ---- internal helpers ------------------------------------------------------

func callAuthEndpoint(path string, body map[string]string) (*AuthResult, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal auth request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, backendURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Auth", internalSecret)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("auth request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth endpoint returned status %d", resp.StatusCode)
	}

	var envelope struct {
		Data AuthResult `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode auth response: %w", err)
	}
	return &envelope.Data, nil
}
