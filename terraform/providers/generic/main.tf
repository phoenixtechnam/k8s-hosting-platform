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

  # For worker nodes, pass the join token via a temp file to avoid
  # exposing it in process arguments or Terraform state.
  provisioner "file" {
    content     = var.role == "worker" ? var.k3s_token : ""
    destination = "/tmp/.k3s-token"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod +x /tmp/bootstrap.sh",
      var.role == "worker" ? "/tmp/bootstrap.sh --domain ${var.domain} --env ${var.environment} --role worker --acme-email ${var.acme_email} --server ${var.k3s_server_ip} --token $(cat /tmp/.k3s-token) && rm -f /tmp/.k3s-token" : "/tmp/bootstrap.sh --domain ${var.domain} --env ${var.environment} --role server --acme-email ${var.acme_email}",
    ]
  }
}
