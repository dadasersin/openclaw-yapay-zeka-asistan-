#!/usr/bin/env bash
# Deploy OpenClaw to Kubernetes.
#
# Secrets are generated in a temp directory and applied directly to the cluster.
# No secret material is ever written to the repo checkout.
#
# Usage:
#   ./k8s/deploy.sh                   # Deploy (requires API key in env or secret already in cluster)
#   ./k8s/deploy.sh --create-secret   # Create the K8s Secret from env vars, then deploy
#   ./k8s/deploy.sh --delete          # Tear down
#
# Environment:
#   OPENCLAW_NAMESPACE   Kubernetes namespace (default: openclaw)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS="$SCRIPT_DIR/manifests"
NS="${OPENCLAW_NAMESPACE:-openclaw}"

# Check prerequisites
for cmd in kubectl openssl; do
  command -v "$cmd" &>/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
kubectl cluster-info &>/dev/null || { echo "Cannot connect to cluster. Check kubeconfig." >&2; exit 1; }

# ---------------------------------------------------------------------------
# -h / --help
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: ./k8s/deploy.sh [OPTION]

  (no args)        Deploy OpenClaw (creates secret from env if needed)
  --create-secret  Create the K8s Secret from env vars without deploying
  --delete         Delete the namespace and all resources
  -h, --help       Show this help

Environment:
  Export at least one provider API key:
    ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY

  OPENCLAW_NAMESPACE     Kubernetes namespace (default: openclaw)
HELP
  exit 0
fi

# ---------------------------------------------------------------------------
# --delete
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--delete" ]]; then
  echo "Deleting namespace '$NS' and all resources..."
  kubectl delete namespace "$NS" --ignore-not-found
  echo "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create and apply Secret to the cluster
# ---------------------------------------------------------------------------
_apply_secret() {
  local TMP_DIR
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  trap 'rm -rf "$TMP_DIR"' EXIT

  local TOKEN
  TOKEN=$(openssl rand -hex 32)

  cat > "$TMP_DIR/secrets.yaml" <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-secrets
  namespace: $NS
  labels:
    app: openclaw
type: Opaque
stringData:
  OPENCLAW_GATEWAY_TOKEN: "$TOKEN"
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}"
  OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
  GEMINI_API_KEY: "${GEMINI_API_KEY:-}"
  OPENROUTER_API_KEY: "${OPENROUTER_API_KEY:-}"
EOF
  chmod 600 "$TMP_DIR/secrets.yaml"

  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl apply -f "$TMP_DIR/secrets.yaml"
  rm -rf "$TMP_DIR"
  trap - EXIT

  echo "Gateway token: $TOKEN"
}

# ---------------------------------------------------------------------------
# --create-secret
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--create-secret" ]]; then
  HAS_KEY=false
  for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    if [[ -n "${!key:-}" ]]; then
      HAS_KEY=true
      echo "  Found $key in environment"
    fi
  done

  if ! $HAS_KEY; then
    echo "No API keys found in environment. Export at least one and re-run:"
    echo "  export <PROVIDER>_API_KEY=\"...\"  (ANTHROPIC, GEMINI, OPENAI, or OPENROUTER)"
    echo "  ./k8s/deploy.sh --create-secret"
    exit 1
  fi

  _apply_secret
  echo ""
  echo "Secret created in namespace '$NS'. Now run:"
  echo "  ./k8s/deploy.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# Check that the secret exists in the cluster
# ---------------------------------------------------------------------------
if ! kubectl get secret openclaw-secrets -n "$NS" &>/dev/null; then
  HAS_KEY=false
  for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    [[ -n "${!key:-}" ]] && HAS_KEY=true
  done

  if $HAS_KEY; then
    echo "Creating secret from environment..."
    _apply_secret
    echo ""
  else
    echo "No secret found and no API keys in environment."
    echo ""
    echo "Export at least one provider API key and re-run:"
    echo "  export <PROVIDER>_API_KEY=\"...\"  (ANTHROPIC, GEMINI, OPENAI, or OPENROUTER)"
    echo "  ./k8s/deploy.sh"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo "Deploying to namespace '$NS'..."
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -k "$MANIFESTS" -n "$NS"
kubectl rollout restart deployment/openclaw -n "$NS" 2>/dev/null || true
echo ""
echo "Waiting for rollout..."
kubectl rollout status deployment/openclaw -n "$NS" --timeout=300s || true
echo ""
echo "Done. Access the gateway:"
echo "  kubectl port-forward svc/openclaw 18789:18789 -n $NS"
echo "  open http://localhost:18789"
echo ""
echo "Gateway token (paste into Control UI):"
echo "  $(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d)"
echo ""
echo "To retrieve the token later:"
echo "  kubectl get secret openclaw-secrets -n $NS -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d"
