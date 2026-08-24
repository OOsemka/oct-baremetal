# Architecture

This repo is two deployables that share a Kubernetes namespace (`oct-baremetal`).

```
OpenShift Console (browser)
  └── dynamic plugin bundle (this repo's webpack dist/)
        ├── Kubernetes API via Console SDK (BMH, DataSource, Secret, …)
        └── Console plugin proxy
              └── discovery-service (Go)
                    ├── Redfish / BMC (register wizard)
                    └── Image cache HTTP for Ironic (deploy)
```

## Frontend plugin

- **Metadata:** `package.json` `consolePlugin` (`name` is the plugin ID) and `console-extensions.json` (nav + routes).
- **Serving:** nginx in `Containerfile` / `nginx.conf`, `deploy/deployment.yaml` + `deploy/service.yaml` on port 9443 with the service-ca serving cert.
- **Enablement:** `ConsolePlugin` CR `oct-baremetal` plus `consoles.operator.openshift.io/cluster` `spec.plugins`.
- **Proxy:** `deploy/consoleplugin.yaml` `spec.proxy[]`. Aliases become `/api/proxy/plugin/oct-baremetal/<alias>/`.

Pages are React components default-exported from `src/components/**` and listed in `exposedModules`. The Console loads them by `$codeRef` on `console.page/route`.

## Discovery-service

See [discovery-service/README.md](../discovery-service/README.md). It exists because the browser cannot open BMC Redfish endpoints (CORS, isolated BMC networks) and because Metal3/Ironic needs an HTTP URL for disk images.

- **Discover:** `POST /api/v1/discover` — used by `RegisterWizardPage.tsx`.
- **Image cache:** download/prepare DataSource images and expose them over HTTP — used by `DeployPage.tsx`.
- **Log ingest:** `POST /api/v1/log` — used by `src/utils/logger.ts` (never send passwords).

## Baremetal deploy pipeline

1. Operator opens **Community Tools → Compute → Bare Metal Hosts** (`/baremetal/nodes`).
2. **Register** (`/baremetal/nodes/register`) calls discovery-service, then creates a BMC Secret and a `BareMetalHost` (`metal3.io/v1alpha1`). Optional NMState Secret for static networking (`NMStateBuilder`).
3. **Deploy** (`/baremetal/nodes/deploy/:ns/:name`) picks a CDI `DataSource` (or a raw HTTP URL), may ask discovery-service to cache the image, then patches the BMH `spec.image` / `spec.online` (and userData / networkData Secrets as needed).
4. Metal3/Ironic provisions the machine.

## Image cache

OpenShift Virtualization golden images are often PVC-backed and not HTTP-fetchable. Discovery-service caches them and returns a cluster-internal URL Ironic can pull. Details live in `discovery-service/imagecache.go` and `src/components/DeployPage.tsx`.

## Adding features without breaking this

New Community Tools extensions should be separate ConsolePlugins. This repo should use the Console SDK against Kubernetes APIs it needs. Only add a proxy alias if the browser cannot reach the API (same reason as Redfish). Keep `/baremetal/...` routes stable.
