variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "ssh_key_name" {
  description = "Name of the SSH key registered in Hetzner Cloud"
  type        = string
}

variable "server_name" {
  description = "Hostname for the k3s server"
  type        = string
  default     = "admin1"
}

variable "location" {
  description = "Hetzner datacenter location"
  type        = string
  default     = "fsn1"

  validation {
    condition     = contains(["fsn1", "nbg1", "hel1", "ash", "hil"], var.location)
    error_message = "Location must be a valid Hetzner datacenter: fsn1, nbg1, hel1, ash, or hil."
  }
}
