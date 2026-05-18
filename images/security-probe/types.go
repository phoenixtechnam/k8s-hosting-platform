// JSON wire format — MUST match
// packages/api-contracts/src/security-hardening.ts.
// Field names use camelCase to match the contract.
package main

// Snapshot is the per-node payload published to a ConfigMap.
type Snapshot struct {
	NodeName      string             `json:"nodeName"`
	GeneratedAt   string             `json:"generatedAt"`
	Mesh          MeshStatus         `json:"mesh"`
	SSH           SSHExposure        `json:"ssh"`
	Hardening     Hardening          `json:"hardening"`
	PublicPortsV4 PublicPorts        `json:"publicPortsV4"`
	Conntrack     ConntrackSnapshot  `json:"conntrack"`
	TopDenied     []DeniedSourceWire `json:"topDenied"`
	CollectErrors []string           `json:"collectErrors,omitempty"`
}

type MeshStatus struct {
	Provider              string  `json:"provider"`
	InterfaceName         *string `json:"interfaceName"`
	InterfaceIP           *string `json:"interfaceIp"`
	PeerCount             *int    `json:"peerCount"`
	LastHandshakeAgeSecs  *int64  `json:"lastHandshakeAgeSeconds"`
}

type SSHFlags struct {
	PermitRootLogin              *string  `json:"permitRootLogin"`
	PasswordAuthentication       *string  `json:"passwordAuthentication"`
	KbdInteractiveAuthentication *string  `json:"kbdInteractiveAuthentication"`
	AllowUsers                   []string `json:"allowUsers"`
	Port                         int      `json:"port"`
	ConfigSha256                 string   `json:"configSha256"`
}

type SSHExposure struct {
	RestrictionMode    string   `json:"restrictionMode"`
	SSHViaMeshFlag     bool     `json:"sshViaMeshFlag"`
	EnforcedInterface  *string  `json:"enforcedInterface"`
	SSHDFlags          SSHFlags `json:"sshdFlags"`
	ParseSucceeded     bool     `json:"parseSucceeded"`
	ParseError         *string  `json:"parseError"`
}

type CISFinding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Observed string `json:"observed"`
	Expected string `json:"expected"`
	Passing  bool   `json:"passing"`
}

type Hardening struct {
	KernelVersion             string       `json:"kernelVersion"`
	KernelEOL                 bool         `json:"kernelEol"`
	TimeSinceRebootSecs       int64        `json:"timeSinceRebootSeconds"`
	PendingKernelUpdate       bool         `json:"pendingKernelUpdate"`
	Fail2banPresent           bool         `json:"fail2banPresent"`
	SshguardPresent           bool         `json:"sshguardPresent"`
	UnattendedUpgradesActive  bool         `json:"unattendedUpgradesActive"`
	AutomaticRebootWindow     *string      `json:"automaticRebootWindow"`
	OSPretty                  string       `json:"osPretty"`
	CISFindings               []CISFinding `json:"cisFindings"`
}

type PublicPorts struct {
	TCP []int `json:"tcp"`
	UDP []int `json:"udp"`
}

type ConntrackSnapshot struct {
	Available     bool    `json:"available"`
	Denies        *int    `json:"denies"`
	WindowSeconds int     `json:"windowSeconds"`
	Reason        *string `json:"reason"`
}

type DeniedSourceWire struct {
	IP          string `json:"ip"`
	Count       int    `json:"count"`
	FirstSeenAt string `json:"firstSeenAt"`
	LastSeenAt  string `json:"lastSeenAt"`
	Family      string `json:"family"`
}
