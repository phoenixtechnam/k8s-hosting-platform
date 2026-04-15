# Generic provider — for servers already provisioned on any cloud or bare metal.
#
# This module doesn't create infrastructure. It accepts an existing server's
# IP address and runs the bootstrap script via SSH to install k3s + platform.
#
# Usage:
#   cd terraform/providers/generic
#   terraform init
#   terraform apply -var="server_ip=1.2.3.4" -var="ssh_private_key_path=~/.ssh/id_rsa"

terraform {
  required_version = ">= 1.5.0"
}

resource "null_resource" "bootstrap" {
  triggers = {
    server_ip   = var.server_ip
    environment = var.environment
    domain      = var.domain
  }

  connection {
    type        = "ssh"
    host        = var.server_ip
    user        = var.ssh_user
    private_key = file(var.ssh_private_key_path)
    timeout     = "5m"
  }

  provisioner "file" {
    source      = "${path.module}/../../../scripts/bootstrap.sh"
    destination = "/tmp/bootstrap.sh"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod +x /tmp/bootstrap.sh",
      "/tmp/bootstrap.sh --domain ${var.domain} --env ${var.environment} --role ${var.role} --acme-email ${var.acme_email}${var.role == "worker" ? " --server ${var.k3s_server_ip} --token ${var.k3s_token}" : ""}",
    ]
  }
}
