-- SSL Certificates table for custom TLS certificate uploads
CREATE TABLE IF NOT EXISTS ssl_certificates (
  id VARCHAR(36) PRIMARY KEY,
  domain_id VARCHAR(36) NOT NULL,
  client_id VARCHAR(36) NOT NULL,
  certificate TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  ca_bundle TEXT,
  issuer VARCHAR(500),
  subject VARCHAR(500),
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX ssl_certs_domain_unique (domain_id),
  INDEX ssl_certs_client_idx (client_id)
);
