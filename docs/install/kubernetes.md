---
summary: "Deploy OpenClaw Gateway to a Kubernetes cluster with Kustomize"
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You need a persistent, always-on Gateway in Kubernetes
title: "Kubernetes"
---

# OpenClaw on Kubernetes

A minimal starting point for running OpenClaw on Kubernetes — not a production-ready deployment. It covers the core resources and is meant to be adapted to your environment.

### Why not Helm?

OpenClaw is a single container with some config files. The interesting customization is in agent content (markdown files, skills, config overrides), not infrastructure templating. Kustomize handles overlays without the overhead of a Helm chart. If your deployment grows more complex, a Helm chart can be layered on top of these manifests.

## What you need

- A running Kubernetes cluster (EKS, GKE, AKS, kind, k3s, OpenShift, etc.)
- `kubectl` connected to your cluster
- An API key for at least one model provider

## Quick start

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

Paste the gateway token (printed at the end of deploy) into the Control UI. To retrieve it later:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

## Local testing with Kind

If you don't have a cluster, create one locally with [Kind](https://kind.sigs.k8s.io/):

```bash
./k8s/create-kind.sh                    # auto-detects docker or podman
./k8s/create-kind.sh --provider podman  # force podman
./k8s/create-kind.sh --delete           # tear down
```

Then deploy as usual with `./k8s/deploy.sh`.

## Step by step

### 1) Deploy

**Option A** — API key in environment (one step):

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./k8s/deploy.sh
```

The script creates a Kubernetes Secret with the API key and an auto-generated gateway token, then deploys.

**Option B** — create the secret separately:

```bash
export <PROVIDER>_API_KEY="..."
./k8s/deploy.sh --create-secret
./k8s/deploy.sh
```

### 2) Access the gateway

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## What gets deployed

```
Namespace: openclaw (configurable via OPENCLAW_NAMESPACE)
├── Deployment/openclaw        # Single pod, init container + gateway
├── Service/openclaw           # ClusterIP on port 18789
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway token + API keys
```

## Customization

### Agent instructions

Edit the `AGENTS.md` in `k8s/manifests/configmap.yaml` and redeploy:

```bash
./k8s/deploy.sh
```

### Gateway config

Edit `openclaw.json` in `k8s/manifests/configmap.yaml`. See [Gateway configuration](/gateway/configuration) for the full reference.

### Add providers

Re-run with additional keys exported:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./k8s/deploy.sh --create-secret
./k8s/deploy.sh
```

Or patch the Secret directly:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### Custom namespace

```bash
OPENCLAW_NAMESPACE=my-namespace ./k8s/deploy.sh
```

### Custom image

Edit the `image` field in `k8s/manifests/deployment.yaml`:

```yaml
image: ghcr.io/openclaw/openclaw:2026.3.1
```

## Re-deploy

```bash
./k8s/deploy.sh
```

This applies all manifests and restarts the pod to pick up any config or secret changes.

## Teardown

```bash
./k8s/deploy.sh --delete
```

This deletes the namespace and all resources in it, including the PVC.

## Architecture notes

- The gateway binds to loopback inside the pod — access it via `kubectl port-forward`
- No cluster-scoped resources — everything lives in a single namespace
- Security: `readOnlyRootFilesystem`, `drop: ALL` capabilities, non-root user (UID 1000)
- `dangerouslyDisableDeviceAuth` is enabled because the Control UI is accessed via HTTP through port-forward. Device auth requires HTTPS (SubtleCrypto). If you expose the gateway via Ingress with TLS, remove this flag
- Secrets are generated in a temp directory and applied directly to the cluster — no secret material is written to the repo checkout

## File structure

```
k8s/
├── deploy.sh                   # Creates namespace + secret, deploys via kustomize
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
└── manifests/
    ├── kustomization.yaml      # Kustomize base
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # Pod spec with security hardening
    ├── pvc.yaml                # 10Gi persistent storage
    └── service.yaml            # ClusterIP on 18789
```
