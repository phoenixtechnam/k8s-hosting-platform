variable "server_ip" {
  description = "IP address of an already-provisioned server"
  type        = string
}

variable "ssh_private_key_path" {
  description = "Path to SSH private key for connecting to the server"
  type        = string
}

variable "ssh_user" {
  description = "SSH user"
  type        = string
  default     = "root"
}

variable "domain" {
  description = "Base domain for the platform (e.g., myplatform.com)"
  type        = string
}

variable "acme_email" {
  description = "Email for Let's Encrypt certificate registration"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "role" {
  description = "Node role"
  type        = string
  default     = "server"
  validation {
    condition     = contains(["server", "worker"], var.role)
    error_message = "Role must be 'server' or 'worker'."
  }
}

variable "k3s_server_ip" {
  description = "Control plane IP (required for worker role)"
  type        = string
  default     = ""
}

variable "k3s_token" {
  description = "k3s join token (required for worker role)"
  type        = string
  default     = ""
  sensitive   = true
}
