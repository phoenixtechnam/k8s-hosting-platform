# Operator-facing convenience targets. Real build/test still lives in
# package.json scripts under backend/, frontend/admin-panel/, etc.
#
# Cluster smoke + failover targets require KUBECONFIG to be set to a
# cluster admin context (e.g. /tmp/k8s-staging/kubeconfig from staging).

.PHONY: help smoke smoke-public failover verdict diagnose

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
