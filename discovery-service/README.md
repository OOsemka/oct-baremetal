# Redfish Discovery Service

A lightweight Go HTTP proxy that sits between the OpenShift console plugin frontend and BMC/iDRAC Redfish APIs. The frontend cannot call Redfish endpoints directly due to CORS and network isolation, so this service runs in-cluster.

## API

### POST /api/v1/discover

Queries a BMC via Redfish and returns aggregated system information (hardware model, NICs, storage, boot mode).

**Request:**

```json
{
  "redfishUrl": "https://172.20.254.184",
  "username": "root",
  "password": "secret"
}
```

**Response:**

```json
{
  "systemInfo": {
    "manufacturer": "Dell Inc.",
    "model": "PowerEdge R7715",
    "serialNumber": "ABC123",
    "uuid": "...",
    "biosVersion": "...",
    "totalMemoryGiB": 256,
    "processorCount": 2,
    "processorModel": "AMD EPYC 9554"
  },
  "bootMode": "UEFI",
  "nics": [ ... ],
  "suggestedBootMac": "40:5B:7F:3A:5B:90",
  "storageDevices": [ ... ]
}
```

### GET /healthz

Returns `200 OK` with `{"status": "ok"}`.

## Build & Run Locally

```bash
cd discovery-service

# Build
go build -o discovery-service .

# Run (HTTP only, no TLS certs needed)
./discovery-service
# Listening on :8080

# Test
curl -X POST http://localhost:8080/api/v1/discover \
  -H "Content-Type: application/json" \
  -d '{"redfishUrl":"https://172.20.254.184","username":"root","password":"secret"}'
```

## Container Build

```bash
podman build -t quay.io/cjanisze/oct-baremetal-discovery:1.1.0-ocp4.22 -f Containerfile .
podman push quay.io/cjanisze/oct-baremetal-discovery:1.1.0-ocp4.22
```

## Deploy to OpenShift

```bash
# PVC first so discovery-service can schedule. Omit storageClassName in the
# manifest to use the cluster default; set spec.storageClassName at create
# if you need a specific class (immutable after Bound).
oc apply -f deploy/image-cache-pvc.yaml
oc apply -f deploy/rbac.yaml
oc apply -f deploy/service.yaml
oc apply -f deploy/route.yaml
oc apply -f deploy/deployment.yaml
```

The service annotation `service.beta.openshift.io/serving-cert-secret-name` tells OpenShift's service-ca to generate a TLS certificate and mount it into the pod. The service listens on HTTPS (8443) in-cluster and HTTP (8080) for health probes.

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--http-port` | `8080` | HTTP listen port |
| `--https-port` | `8443` | HTTPS listen port |
| `--tls-cert` | `/var/run/secrets/tls/tls.crt` | TLS certificate path |
| `--tls-key` | `/var/run/secrets/tls/tls.key` | TLS key path |
