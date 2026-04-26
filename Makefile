# Operator-facing convenience targets. Real build/test still lives in
# package.json scripts under backend/, frontend/admin-panel/, etc.
#
# Cluster smoke + failover targets require KUBECONFIG to be set to a
# cluster admin context (e.g. /tmp/k8s-staging/kubeconfig from staging).

# Pipefail by default so failing pipe stages (e.g. `age -d` failing
# upstream of `tar -xf -`) propagate. Without this, secrets-restore
# would silently succeed if decryption failed.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

.PHONY: help smoke smoke-public failover verdict diagnose secrets-fetch secrets-restore

# Default — list targets with one-line descriptions.
help:
	@awk 'BEGIN {FS = ":.*##"; printf "make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

smoke:        ## Full cluster-network smoke suite (needs KUBECONFIG)
	@scripts/smoke-test-cluster-network.sh

smoke-public: ## Test 1 only (external-IP DNS probe — no kubeconfig)
	@scripts/smoke-test-cluster-network.sh --skip 2,3,4,5,6

failover:     ## Induced-failure drills (DESTRUCTIVE — drains nodes)
	@scripts/failover-test.sh

verdict:      ## Quick PASS/FAIL count summary (JSON-driven)
	@scripts/smoke-test-cluster-network.sh --json 2>/dev/null \
		| awk -F'"' '/"status":"PASS"/ {p++} /"status":"FAIL"/ {f++} END {printf "PASS=%d FAIL=%d\n", p+0, f+0}'

secrets-fetch: ## Pull bootstrap secrets bundle + operator key off a server (HOST=root@<ip> required)
	@if [ -z "$(HOST)" ]; then echo "usage: make secrets-fetch HOST=root@<server> [SSH_KEY=~/hosting-platform.key]" >&2; exit 2; fi
	@SSH_KEY="$${SSH_KEY:-$$HOME/hosting-platform.key}"; \
	DST="$${DST:-$$HOME/k8s-staging}"; \
	mkdir -p "$$DST"; \
	echo "fetching secrets artifacts from $(HOST) → $$DST/"; \
	ssh -i "$$SSH_KEY" -o StrictHostKeyChecking=accept-new $(HOST) 'ls /var/lib/hosting-platform/bundles/*.tar.age 2>/dev/null; ls /var/lib/hosting-platform/operator-key/*.key /var/lib/hosting-platform/operator-key/*.pub 2>/dev/null' \
	| while read -r REMOTE; do \
		[ -z "$$REMOTE" ] && continue; \
		BASE=$$(basename "$$REMOTE"); \
		echo "  $$REMOTE → $$DST/$$BASE"; \
		scp -q -i "$$SSH_KEY" -o StrictHostKeyChecking=accept-new "$(HOST):$$REMOTE" "$$DST/$$BASE"; \
	  done; \
	echo "done. Verify each file, then DELETE from server: ssh $(HOST) 'shred -u <path>'"

secrets-restore: ## Restore Secrets from a local age-encrypted bundle (BUNDLE=path KEY=path required)
	@if [ -z "$(BUNDLE)" ] || [ -z "$(KEY)" ]; then echo "usage: make secrets-restore BUNDLE=~/k8s-staging/bundle.tar.age KEY=~/k8s-staging/operator-private.key" >&2; exit 2; fi
	@if ! command -v age >/dev/null 2>&1; then echo "age not installed (apt-get install -y age)" >&2; exit 2; fi
	@if [ -z "$$KUBECONFIG" ]; then echo "KUBECONFIG must be set" >&2; exit 2; fi
	@TMP=$$(mktemp -d); \
	echo "decrypting $(BUNDLE) → $$TMP/"; \
	age -d -i "$(KEY)" "$(BUNDLE)" | tar -C "$$TMP" -xf -; \
	echo "applying Secret manifests:"; \
	for f in $$TMP/*.yaml; do \
		[ -f "$$f" ] || continue; \
		echo "  $$f"; \
		kubectl apply -f "$$f"; \
	  done; \
	find "$$TMP" -type f -exec sh -c ': > "$$1"' _ {} \; 2>/dev/null; \
	rm -rf "$$TMP"; \
	echo "done. Pods may need restart to pick up new Secret values: kubectl rollout restart -n <ns> deploy/<name>"

diagnose:     ## Capture forensic snapshot (nodes/pods/Felix logs) under docs/diagnostics/<utc-stamp>/
	@DST=docs/diagnostics/$$(date -u '+%Y%m%dT%H%M%SZ'); mkdir -p "$$DST"; \
	echo "diagnostics → $$DST"; \
	kubectl get nodes -o wide > $$DST/nodes.txt 2>&1; \
	kubectl get pods -A -o wide > $$DST/pods.txt 2>&1; \
	kubectl get installation default -o yaml > $$DST/installation.yaml 2>&1 || true; \
	kubectl get felixconfigurations.crd.projectcalico.org default -o yaml > $$DST/felix.yaml 2>&1 || true; \
	kubectl logs -n calico-system -l k8s-app=calico-node --tail=200 --max-log-requests=10 > $$DST/calico-node-logs.txt 2>&1 || true; \
	scripts/smoke-test-cluster-network.sh > $$DST/smoke.log 2>&1 || true; \
	echo "done. Files: $$(ls $$DST | tr '\n' ' ')"
