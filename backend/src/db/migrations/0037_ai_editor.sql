-- Migration 0037: AI Editor — providers, models, and usage tracking

CREATE TABLE IF NOT EXISTS "ai_providers" (
  "id"           VARCHAR(100) PRIMARY KEY,
  "type"         VARCHAR(30) NOT NULL,
  "display_name" VARCHAR(200) NOT NULL,
  "base_url"     VARCHAR(500),
  "api_key_enc"  TEXT,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ai_models" (
  "id"                        VARCHAR(100) PRIMARY KEY,
  "provider_id"               VARCHAR(100) NOT NULL REFERENCES "ai_providers"("id") ON DELETE CASCADE,
  "model_name"                VARCHAR(200) NOT NULL,
  "display_name"              VARCHAR(200) NOT NULL,
  "cost_per_1m_input_tokens"  NUMERIC(10,4) DEFAULT 0,
  "cost_per_1m_output_tokens" NUMERIC(10,4) DEFAULT 0,
  "max_output_tokens"         INTEGER NOT NULL DEFAULT 4096,
  "enabled"                   BOOLEAN NOT NULL DEFAULT true,
  "created_at"                TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ai_token_usage" (
  "id"              VARCHAR(36) PRIMARY KEY,
  "client_id"       VARCHAR(36) NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "deployment_id"   VARCHAR(36) REFERENCES "deployments"("id") ON DELETE SET NULL,
  "model_id"        VARCHAR(100) NOT NULL REFERENCES "ai_models"("id"),
  "mode"            VARCHAR(20) NOT NULL,
  "tokens_input"    INTEGER NOT NULL,
  "tokens_output"   INTEGER NOT NULL,
  "instruction"     TEXT,
  "created_at"      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "ai_token_usage_client_idx" ON "ai_token_usage"("client_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_token_usage_model_idx" ON "ai_token_usage"("model_id");
