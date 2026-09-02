package main

// Image cache for Ironic. Cluster-portable: never hardcode a StorageClass,
// network, or other lab-specific value. Use the class chosen at Add
// (image-cache PVC) or a CSI driver match from the live cluster.

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultCacheDir      = "/data/image-cache"
	defaultOSImagesNS    = "openshift-virtualization-os-images"
	vmExportTTL          = "2h"
	vmExportPollInterval = 3 * time.Second
	vmExportPollTimeout  = 10 * time.Minute
)

type CachePhase string

const (
	CachePhaseQueued      CachePhase = "queued"
	CachePhaseExporting   CachePhase = "exporting"
	CachePhaseDownloading CachePhase = "downloading"
	CachePhaseReady       CachePhase = "ready"
	CachePhaseError       CachePhase = "error"
)

type CachedImage struct {
	Name               string     `json:"name"`
	DataSourceName     string     `json:"dataSourceName"`
	Namespace          string     `json:"namespace"`
	Phase              CachePhase `json:"phase"`
	DownloadURL        string     `json:"downloadUrl,omitempty"`
	ChecksumURL        string     `json:"checksumUrl,omitempty"`
	ExternalURL        string     `json:"externalUrl,omitempty"`
	ExternalChecksumURL string    `json:"externalChecksumUrl,omitempty"`
	SHA256             string     `json:"sha256,omitempty"`
	SizeBytes          int64      `json:"sizeBytes,omitempty"`
	Error              string     `json:"error,omitempty"`
	FileName           string     `json:"fileName"`
	StartedAt          time.Time  `json:"startedAt"`
}

type ImageCacheManager struct {
	k8s             *K8sClient
	cacheDir        string
	baseURL         string
	externalBaseURL string
	images          map[string]*CachedImage
	mu              sync.RWMutex
}

func NewImageCacheManager(k8s *K8sClient) *ImageCacheManager {
	cacheDir := os.Getenv("IMAGE_CACHE_DIR")
	if cacheDir == "" {
		cacheDir = defaultCacheDir
	}
	os.MkdirAll(cacheDir, 0755)

	baseURL := os.Getenv("IMAGE_CACHE_BASE_URL")
	if baseURL == "" {
		baseURL = "http://discovery-service.oct-baremetal.svc:8080"
	}

	mgr := &ImageCacheManager{
		k8s:      k8s,
		cacheDir: cacheDir,
		baseURL:  baseURL,
		images:   make(map[string]*CachedImage),
	}

	// Best-effort at startup. Status/prepare/list re-read the Route if this
	// is still empty (the Route may not exist yet when the pod first starts).
	_ = mgr.getExternalBaseURL()

	mgr.scanExistingCache()
	return mgr
}

const (
	routeName      = "image-cache"
	routeNamespace = "oct-baremetal"
)

// getExternalBaseURL returns the public image-cache base URL.
// IMAGE_CACHE_EXTERNAL_URL is an override. Otherwise the image-cache Route
// is used; a successful lookup is cached. If the Route was missing at
// process start, each status/prepare/list call retries until it succeeds.
func (m *ImageCacheManager) getExternalBaseURL() string {
	if envURL := os.Getenv("IMAGE_CACHE_EXTERNAL_URL"); envURL != "" {
		trimmed := strings.TrimRight(envURL, "/")
		m.mu.Lock()
		prev := m.externalBaseURL
		m.externalBaseURL = trimmed
		m.mu.Unlock()
		if prev != trimmed {
			log.Printf("[IMAGE-CACHE] Using external URL from env: %s", trimmed)
		}
		return trimmed
	}

	m.mu.RLock()
	cached := m.externalBaseURL
	m.mu.RUnlock()
	if cached != "" {
		return cached
	}

	url := m.lookupRouteURL()
	if url == "" {
		return ""
	}

	m.mu.Lock()
	if m.externalBaseURL == "" {
		m.externalBaseURL = url
	}
	cached = m.externalBaseURL
	m.mu.Unlock()
	return cached
}

// lookupRouteURL reads the image-cache Route from the plugin namespace.
func (m *ImageCacheManager) lookupRouteURL() string {
	if m.k8s == nil {
		return ""
	}
	path := fmt.Sprintf("/apis/route.openshift.io/v1/namespaces/%s/routes/%s", routeNamespace, routeName)
	route, err := m.k8s.Get(path)
	if err != nil {
		log.Printf("[IMAGE-CACHE] Could not read Route %s/%s: %v — external URLs unavailable", routeNamespace, routeName, err)
		return ""
	}
	externalURL := parseRouteExternalURL(route)
	if externalURL == "" {
		log.Printf("[IMAGE-CACHE] Route %s/%s has no host", routeNamespace, routeName)
		return ""
	}
	log.Printf("[IMAGE-CACHE] Discovered external URL from Route: %s", externalURL)
	return externalURL
}

func parseRouteExternalURL(route map[string]interface{}) string {
	spec, _ := route["spec"].(map[string]interface{})
	if spec == nil {
		return ""
	}
	host, _ := spec["host"].(string)
	if host == "" {
		return ""
	}
	scheme := "http"
	if tlsSpec, ok := spec["tls"].(map[string]interface{}); ok && tlsSpec != nil {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, host)
}

func applyExternalURLs(img *CachedImage, base string) {
	if img == nil || base == "" {
		return
	}
	fileName := img.FileName
	if fileName == "" && img.Name != "" {
		fileName = img.Name + ".img"
	}
	if fileName == "" {
		return
	}
	base = strings.TrimRight(base, "/")
	img.ExternalURL = fmt.Sprintf("%s/api/v1/image-cache/images/%s", base, fileName)
	img.ExternalChecksumURL = fmt.Sprintf("%s/api/v1/image-cache/images/%s.sha256sum", base, fileName)
}

// scanExistingCache rebuilds the in-memory index from files already on the PVC.
func (m *ImageCacheManager) scanExistingCache() {
	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		log.Printf("[IMAGE-CACHE] Cannot read cache dir %s: %v", m.cacheDir, err)
		return
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".img") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".img")
		checksumPath := filepath.Join(m.cacheDir, e.Name()+".sha256sum")
		sha256Hash := ""
		if data, err := os.ReadFile(checksumPath); err == nil {
			parts := strings.Fields(string(data))
			if len(parts) > 0 {
				sha256Hash = parts[0]
			}
		} else {
			// No checksum → incomplete download; skip
			continue
		}

		info, _ := e.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}

		img := &CachedImage{
			Name:        name,
			Phase:       CachePhaseReady,
			DownloadURL: fmt.Sprintf("%s/api/v1/image-cache/images/%s", m.baseURL, e.Name()),
			ChecksumURL: fmt.Sprintf("%s/api/v1/image-cache/images/%s.sha256sum", m.baseURL, e.Name()),
			SHA256:      sha256Hash,
			SizeBytes:   size,
			FileName:    e.Name(),
		}
		applyExternalURLs(img, m.externalBaseURL)
		m.images[name] = img
		log.Printf("[IMAGE-CACHE] Restored cached image: %s (%d bytes)", name, size)
	}
	log.Printf("[IMAGE-CACHE] Startup scan: %d cached images", len(m.images))
}

// ── HTTP handlers ───────────────────────────────────────────────────────

func (m *ImageCacheManager) handlePrepare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DataSourceName string `json:"dataSourceName"`
		Namespace      string `json:"namespace"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[IMAGE-CACHE] ERROR: invalid prepare request — detail: %v", err)
		writeError(w, http.StatusBadRequest, "invalid request: "+err.Error())
		return
	}
	if req.DataSourceName == "" {
		log.Printf("[IMAGE-CACHE] ERROR: prepare request missing dataSourceName")
		writeError(w, http.StatusBadRequest, "dataSourceName is required")
		return
	}
	if req.Namespace == "" {
		req.Namespace = defaultOSImagesNS
	}

	name := req.DataSourceName
	base := m.getExternalBaseURL()

	m.mu.Lock()
	existing, exists := m.images[name]
	if exists && existing.Phase != CachePhaseError {
		applyExternalURLs(existing, base)
		out := *existing
		m.mu.Unlock()
		log.Printf("[IMAGE-CACHE] Cache hit — name: %s, phase: %s, size: %d bytes, externalUrl: %s", name, out.Phase, out.SizeBytes, out.ExternalURL)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(&out)
		return
	}
	m.mu.Unlock()

	log.Printf("[IMAGE-CACHE] Cache miss — preparing DataSource: %s/%s", req.Namespace, name)

	record := &CachedImage{
		Name:           name,
		DataSourceName: req.DataSourceName,
		Namespace:      req.Namespace,
		Phase:          CachePhaseQueued,
		FileName:       name + ".img",
		StartedAt:      time.Now(),
	}
	record.DownloadURL = fmt.Sprintf("%s/api/v1/image-cache/images/%s", m.baseURL, record.FileName)
	record.ChecksumURL = fmt.Sprintf("%s/api/v1/image-cache/images/%s.sha256sum", m.baseURL, record.FileName)
	applyExternalURLs(record, base)

	m.mu.Lock()
	m.images[name] = record
	m.mu.Unlock()

	go m.cacheImage(record)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(record)
}

func (m *ImageCacheManager) handleStatus(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		log.Printf("[IMAGE-CACHE] ERROR: status request missing name")
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	base := m.getExternalBaseURL()

	m.mu.Lock()
	record, exists := m.images[name]
	var out CachedImage
	if exists {
		applyExternalURLs(record, base)
		out = *record
	}
	m.mu.Unlock()
	if !exists {
		writeError(w, http.StatusNotFound, "image not found: "+name)
		return
	}

	if out.DownloadURL != "" && out.ExternalURL == "" {
		log.Printf("[IMAGE-CACHE] WARNING: status for %s has downloadUrl but no externalUrl — Route not discovered yet", name)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(&out)
}

func (m *ImageCacheManager) handleList(w http.ResponseWriter, _ *http.Request) {
	base := m.getExternalBaseURL()

	m.mu.Lock()
	list := make([]*CachedImage, 0, len(m.images))
	var totalBytes int64
	readyCount := 0
	for _, img := range m.images {
		applyExternalURLs(img, base)
		cp := *img
		list = append(list, &cp)
		totalBytes += img.SizeBytes
		if img.Phase == CachePhaseReady {
			readyCount++
		}
	}
	m.mu.Unlock()

	log.Printf("[IMAGE-CACHE] List requested — total: %d, ready: %d, totalSize: %s",
		len(list), readyCount, humanBytes(totalBytes))

	resp := struct {
		Images     []*CachedImage `json:"images"`
		TotalBytes int64          `json:"totalBytes"`
		TotalHuman string         `json:"totalHuman"`
		Count      int            `json:"count"`
	}{
		Images:     list,
		TotalBytes: totalBytes,
		TotalHuman: humanBytes(totalBytes),
		Count:      len(list),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleServeFile serves cached image and checksum files over plain HTTP.
// Metal3/Ironic fetches directly from these URLs.
func (m *ImageCacheManager) handleServeFile(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if filename == "" {
		log.Printf("[IMAGE-CACHE] ERROR: serve request missing filename — remote: %s", r.RemoteAddr)
		writeError(w, http.StatusBadRequest, "filename is required")
		return
	}

	clean := filepath.Clean(filename)
	if strings.Contains(clean, "/") || strings.Contains(clean, "\\") || strings.HasPrefix(clean, ".") {
		log.Printf("[IMAGE-CACHE] ERROR: invalid filename requested — filename: %s, remote: %s", clean, r.RemoteAddr)
		writeError(w, http.StatusBadRequest, "invalid filename")
		return
	}

	filePath := filepath.Join(m.cacheDir, clean)
	info, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		log.Printf("[IMAGE-CACHE] ERROR: file not found — filename: %s, remote: %s", clean, r.RemoteAddr)
		writeError(w, http.StatusNotFound, "file not found: "+clean)
		return
	}

	log.Printf("[IMAGE-CACHE] Serving file — name: %s, size: %s (%d bytes), remote: %s",
		clean, humanBytes(info.Size()), info.Size(), r.RemoteAddr)

	if strings.HasSuffix(clean, ".sha256sum") {
		w.Header().Set("Content-Type", "text/plain")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", clean))
	}
	http.ServeFile(w, r, filePath)
}

func (m *ImageCacheManager) handleDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		log.Printf("[IMAGE-CACHE] ERROR: delete request missing name")
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	m.mu.Lock()
	record, exists := m.images[name]
	if exists {
		delete(m.images, name)
	}
	m.mu.Unlock()
	if !exists {
		log.Printf("[IMAGE-CACHE] ERROR: delete requested for unknown image — name: %s", name)
		writeError(w, http.StatusNotFound, "image not found: "+name)
		return
	}

	freedBytes := record.SizeBytes
	os.Remove(filepath.Join(m.cacheDir, record.FileName))
	os.Remove(filepath.Join(m.cacheDir, record.FileName+".sha256sum"))

	log.Printf("[IMAGE-CACHE] Deleted cached image — name: %s, freed: %s (%d bytes)", name, humanBytes(freedBytes), freedBytes)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// ── Background caching pipeline ─────────────────────────────────────────

func (m *ImageCacheManager) cacheImage(record *CachedImage) {
	startTime := time.Now()

	// 1. Resolve DataSource → PVC or VolumeSnapshot
	log.Printf("[IMAGE-CACHE] Resolving DataSource — namespace: %s, name: %s", record.Namespace, record.DataSourceName)
	pvcName, snapshotName, err := m.resolveDataSource(record.Namespace, record.DataSourceName)
	if err != nil {
		m.setError(record, "resolve DataSource: "+err.Error())
		return
	}

	sourcePVC := pvcName
	tempPVCName := ""

	if snapshotName != "" {
		log.Printf("[IMAGE-CACHE] DataSource resolved — name: %s, sourceType: VolumeSnapshot, snapshot: %s", record.Name, snapshotName)
	} else {
		log.Printf("[IMAGE-CACHE] DataSource resolved — name: %s, sourceType: PVC, pvc: %s", record.Name, pvcName)
	}

	// 2. If snapshot-backed, create a temporary PVC from the snapshot
	if snapshotName != "" {
		tempPVCName = "bmh-temp-" + record.Name
		log.Printf("[IMAGE-CACHE] Creating temp PVC from snapshot — pvc: %s, snapshot: %s, namespace: %s", tempPVCName, snapshotName, record.Namespace)
		if err := m.createPVCFromSnapshot(record.Namespace, tempPVCName, snapshotName); err != nil {
			m.setError(record, "create temp PVC: "+err.Error())
			return
		}
		sourcePVC = tempPVCName
		defer func() {
			log.Printf("[IMAGE-CACHE] Cleaning up temp PVC — name: %s, namespace: %s", tempPVCName, record.Namespace)
			m.deletePVC(record.Namespace, tempPVCName)
		}()
	}

	m.setPhase(record, CachePhaseExporting)

	// 3. Create a VMExport to get HTTP access to the PVC contents
	exportName := "bmh-cache-" + record.Name
	log.Printf("[IMAGE-CACHE] Creating VMExport — name: %s, sourcePVC: %s, namespace: %s", exportName, sourcePVC, record.Namespace)
	if err := m.createVMExport(record.Namespace, exportName, sourcePVC); err != nil {
		if !strings.Contains(err.Error(), "already exists") {
			m.setError(record, "create VMExport: "+err.Error())
			return
		}
		log.Printf("[IMAGE-CACHE] VMExport already exists — name: %s, reusing", exportName)
	}
	defer m.deleteVMExport(record.Namespace, exportName)

	// 4. Wait for export to be Ready; get internal URL + token
	log.Printf("[IMAGE-CACHE] Waiting for VMExport ready — name: %s, timeout: %v", exportName, vmExportPollTimeout)
	internalURL, tokenSecretName, err := m.waitForExport(record.Namespace, exportName)
	if err != nil {
		m.setError(record, "wait for export: "+err.Error())
		return
	}
	log.Printf("[IMAGE-CACHE] VMExport ready — name: %s, downloadURL: %s", exportName, internalURL)

	token, err := m.getExportToken(record.Namespace, tokenSecretName)
	if err != nil {
		m.setError(record, "get export token: "+err.Error())
		return
	}

	m.setPhase(record, CachePhaseDownloading)
	log.Printf("[IMAGE-CACHE] Starting download — image: %s, source: %s", record.Name, internalURL)

	// 5. Stream image to our PVC, computing SHA256 on the fly
	imgPath := filepath.Join(m.cacheDir, record.FileName)
	hash, size, err := downloadAndHash(internalURL, token, imgPath)
	if err != nil {
		os.Remove(imgPath)
		m.setError(record, "download: "+err.Error())
		return
	}

	log.Printf("[IMAGE-CACHE] SHA-256 computed — image: %s, hash: %s", record.Name, hash)

	// 6. Write companion .sha256sum file
	checksumContent := fmt.Sprintf("%s  %s\n", hash, record.FileName)
	if err := os.WriteFile(imgPath+".sha256sum", []byte(checksumContent), 0644); err != nil {
		m.setError(record, "write checksum file: "+err.Error())
		return
	}

	// 7. Done
	elapsed := time.Since(startTime)
	m.mu.Lock()
	record.Phase = CachePhaseReady
	record.SHA256 = hash
	record.SizeBytes = size
	m.mu.Unlock()

	log.Printf("[IMAGE-CACHE] Image cached — name: %s, size: %s (%d bytes), sha256: %s, duration: %v",
		record.Name, humanBytes(size), size, hash, elapsed.Round(time.Second))
}

// ── Kubernetes helpers ──────────────────────────────────────────────────

func (m *ImageCacheManager) resolveDataSource(ns, name string) (pvcName, snapshotName string, err error) {
	path := fmt.Sprintf("/apis/cdi.kubevirt.io/v1beta1/namespaces/%s/datasources/%s", ns, name)
	ds, err := m.k8s.Get(path)
	if err != nil {
		log.Printf("[IMAGE-CACHE] ERROR: failed to get DataSource — namespace: %s, name: %s, detail: %v", ns, name, err)
		return "", "", err
	}

	status, _ := ds["status"].(map[string]interface{})
	if status == nil {
		log.Printf("[IMAGE-CACHE] ERROR: DataSource has no status — namespace: %s, name: %s", ns, name)
		return "", "", fmt.Errorf("DataSource %s has no status", name)
	}
	source, _ := status["source"].(map[string]interface{})
	if source == nil {
		log.Printf("[IMAGE-CACHE] ERROR: DataSource has no status.source — namespace: %s, name: %s", ns, name)
		return "", "", fmt.Errorf("DataSource %s has no status.source", name)
	}

	if pvc, ok := source["pvc"].(map[string]interface{}); ok {
		if n, _ := pvc["name"].(string); n != "" {
			return n, "", nil
		}
	}
	if snap, ok := source["snapshot"].(map[string]interface{}); ok {
		if n, _ := snap["name"].(string); n != "" {
			return "", n, nil
		}
	}
	log.Printf("[IMAGE-CACHE] ERROR: DataSource has no PVC or snapshot source — namespace: %s, name: %s", ns, name)
	return "", "", fmt.Errorf("DataSource %s has no PVC or snapshot source", name)
}

func (m *ImageCacheManager) createPVCFromSnapshot(ns, pvcName, snapshotName string) error {
	snapPath := fmt.Sprintf("/apis/snapshot.storage.k8s.io/v1/namespaces/%s/volumesnapshots/%s", ns, snapshotName)
	snap, err := m.k8s.Get(snapPath)
	if err != nil {
		return fmt.Errorf("get VolumeSnapshot %s: %w", snapshotName, err)
	}

	restoreSize := "30Gi"
	if status, ok := snap["status"].(map[string]interface{}); ok {
		if rs, _ := status["restoreSize"].(string); rs != "" {
			restoreSize = rs
		}
	}
	log.Printf("[IMAGE-CACHE] Snapshot info — snapshot: %s, restoreSize: %s", snapshotName, restoreSize)

	pvcSpec := map[string]interface{}{
		"dataSource": map[string]interface{}{
			"name":     snapshotName,
			"kind":     "VolumeSnapshot",
			"apiGroup": "snapshot.storage.k8s.io",
		},
		"accessModes": []string{"ReadWriteOnce"},
		"volumeMode":  "Block",
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{
				"storage": restoreSize,
			},
		},
	}
	storageClass := m.storageClassForTempPVC(snap)
	if storageClass != "" {
		pvcSpec["storageClassName"] = storageClass
		log.Printf("[IMAGE-CACHE] Temp PVC storage class — name: %s", storageClass)
	} else {
		log.Printf("[IMAGE-CACHE] Temp PVC storage class omitted (cluster default)")
	}

	pvc := map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "PersistentVolumeClaim",
		"metadata": map[string]interface{}{
			"name":      pvcName,
			"namespace": ns,
			"labels": map[string]interface{}{
				"app.kubernetes.io/managed-by": "oct-baremetal",
				"baremetal-dashboard/temp-pvc":  "true",
			},
		},
		"spec": pvcSpec,
	}

	pvcPath := fmt.Sprintf("/api/v1/namespaces/%s/persistentvolumeclaims", ns)
	if _, err := m.k8s.Create(pvcPath, pvc); err != nil && !strings.Contains(err.Error(), "already exists") {
		return err
	}

	// Wait for Bound
	getPath := fmt.Sprintf("/api/v1/namespaces/%s/persistentvolumeclaims/%s", ns, pvcName)
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		obj, err := m.k8s.Get(getPath)
		if err == nil {
			if st, ok := obj["status"].(map[string]interface{}); ok {
				if phase, _ := st["phase"].(string); phase == "Bound" {
					log.Printf("[IMAGE-CACHE] Temp PVC %s bound", pvcName)
					return nil
				}
			}
			if msg := pvcProvisioningFailure(obj); msg != "" {
				return fmt.Errorf("temp PVC %s failed to provision: %s", pvcName, msg)
			}
		}
		time.Sleep(3 * time.Second)
	}
	log.Printf("[IMAGE-CACHE] ERROR: temp PVC bind timeout — pvc: %s, namespace: %s", pvcName, ns)
	return fmt.Errorf("temp PVC %s did not bind within 5 min", pvcName)
}

func pvcProvisioningFailure(obj map[string]interface{}) string {
	status, _ := obj["status"].(map[string]interface{})
	if status == nil {
		return ""
	}
	conds, _ := status["conditions"].([]interface{})
	for _, raw := range conds {
		c, _ := raw.(map[string]interface{})
		if c == nil {
			continue
		}
		typ, _ := c["type"].(string)
		msg, _ := c["message"].(string)
		if typ == "Resizing" {
			continue
		}
		if strings.Contains(strings.ToLower(msg), "not found") || strings.Contains(strings.ToLower(msg), "provisioning failed") {
			return msg
		}
	}
	return ""
}

// installStorageClass is the StorageClass chosen at storefront Add for PVC
// image-cache. Never hardcode a class name.
func (m *ImageCacheManager) installStorageClass() string {
	ns := strings.TrimSpace(os.Getenv("POD_NAMESPACE"))
	if ns == "" {
		ns = "oct-baremetal"
	}
	pvc, err := m.k8s.Get(fmt.Sprintf("/api/v1/namespaces/%s/persistentvolumeclaims/image-cache", ns))
	if err != nil {
		log.Printf("[IMAGE-CACHE] Could not read image-cache PVC in %s: %v", ns, err)
		return ""
	}
	spec, _ := pvc["spec"].(map[string]interface{})
	if spec == nil {
		return ""
	}
	sc, _ := spec["storageClassName"].(string)
	return strings.TrimSpace(sc)
}

// storageClassForTempPVC uses the Add StorageClass when that class can restore
// the snapshot (same CSI driver as the VolumeSnapshotClass). Otherwise it
// picks a StorageClass with that driver — kubevirt default virt class, else
// cluster default, else first match. Never a hardcoded name.
func (m *ImageCacheManager) storageClassForTempPVC(snap map[string]interface{}) string {
	add := m.installStorageClass()
	driver := m.snapshotCSIDriver(snap)
	if add != "" {
		if driver == "" || m.storageClassProvisioner(add) == driver {
			return add
		}
		log.Printf("[IMAGE-CACHE] Add StorageClass %s cannot restore this snapshot (CSI driver %s); selecting a compatible class", add, driver)
	}
	if driver != "" {
		if match := m.storageClassForCSIDriver(driver); match != "" {
			return match
		}
	}
	return add
}

func (m *ImageCacheManager) snapshotCSIDriver(snap map[string]interface{}) string {
	spec, _ := snap["spec"].(map[string]interface{})
	if spec == nil {
		return ""
	}
	snapClass, _ := spec["volumeSnapshotClassName"].(string)
	if snapClass == "" {
		return ""
	}
	vsc, err := m.k8s.Get("/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses/" + snapClass)
	if err != nil {
		log.Printf("[IMAGE-CACHE] Could not get VolumeSnapshotClass %s: %v", snapClass, err)
		return ""
	}
	driver, _ := vsc["driver"].(string)
	return strings.TrimSpace(driver)
}

func (m *ImageCacheManager) storageClassProvisioner(name string) string {
	if name == "" {
		return ""
	}
	sc, err := m.k8s.Get("/apis/storage.k8s.io/v1/storageclasses/" + name)
	if err != nil {
		log.Printf("[IMAGE-CACHE] Could not get StorageClass %s: %v", name, err)
		return ""
	}
	p, _ := sc["provisioner"].(string)
	return strings.TrimSpace(p)
}

func (m *ImageCacheManager) storageClassForCSIDriver(driver string) string {
	list, err := m.k8s.Get("/apis/storage.k8s.io/v1/storageclasses")
	if err != nil {
		log.Printf("[IMAGE-CACHE] Could not list StorageClasses: %v", err)
		return ""
	}
	items, _ := list["items"].([]interface{})
	var first, k8sDefault, virtDefault string
	for _, raw := range items {
		sc, _ := raw.(map[string]interface{})
		if sc == nil {
			continue
		}
		prov, _ := sc["provisioner"].(string)
		if prov != driver {
			continue
		}
		meta, _ := sc["metadata"].(map[string]interface{})
		name, _ := meta["name"].(string)
		if name == "" {
			continue
		}
		if first == "" {
			first = name
		}
		ann, _ := meta["annotations"].(map[string]interface{})
		if fmt.Sprint(ann["storageclass.kubevirt.io/is-default-virt-class"]) == "true" {
			virtDefault = name
		}
		if fmt.Sprint(ann["storageclass.kubernetes.io/is-default-class"]) == "true" {
			k8sDefault = name
		}
	}
	if virtDefault != "" {
		return virtDefault
	}
	if k8sDefault != "" {
		return k8sDefault
	}
	return first
}

func (m *ImageCacheManager) createVMExport(ns, exportName, pvcName string) error {
	obj := map[string]interface{}{
		"apiVersion": "export.kubevirt.io/v1beta1",
		"kind":       "VirtualMachineExport",
		"metadata": map[string]interface{}{
			"name":      exportName,
			"namespace": ns,
			"labels": map[string]interface{}{
				"app.kubernetes.io/managed-by": "oct-baremetal",
			},
		},
		"spec": map[string]interface{}{
			"source": map[string]interface{}{
				"apiGroup": "",
				"kind":     "PersistentVolumeClaim",
				"name":     pvcName,
			},
			"ttlDuration": vmExportTTL,
		},
	}
	path := fmt.Sprintf("/apis/export.kubevirt.io/v1beta1/namespaces/%s/virtualmachineexports", ns)
	_, err := m.k8s.Create(path, obj)
	return err
}

func (m *ImageCacheManager) waitForExport(ns, exportName string) (internalURL, tokenSecret string, err error) {
	path := fmt.Sprintf("/apis/export.kubevirt.io/v1beta1/namespaces/%s/virtualmachineexports/%s", ns, exportName)
	deadline := time.Now().Add(vmExportPollTimeout)
	lastLogPhase := ""

	for time.Now().Before(deadline) {
		obj, err := m.k8s.Get(path)
		if err != nil {
			time.Sleep(vmExportPollInterval)
			continue
		}
		status, _ := obj["status"].(map[string]interface{})
		if status == nil {
			time.Sleep(vmExportPollInterval)
			continue
		}
		phase, _ := status["phase"].(string)
		if phase != "Ready" {
			if phase != lastLogPhase {
				log.Printf("[IMAGE-CACHE] VMExport polling — name: %s, phase: %s", exportName, phase)
				lastLogPhase = phase
			}
			time.Sleep(vmExportPollInterval)
			continue
		}

		url, err := extractInternalDownloadURL(status)
		if err != nil {
			log.Printf("[IMAGE-CACHE] ERROR: failed to extract download URL from VMExport — name: %s, detail: %v", exportName, err)
			return "", "", err
		}
		tokenRef, _ := status["tokenSecretRef"].(string)
		if tokenRef == "" {
			log.Printf("[IMAGE-CACHE] ERROR: VMExport missing tokenSecretRef — name: %s", exportName)
			return "", "", fmt.Errorf("VMExport %s missing tokenSecretRef", exportName)
		}
		return url, tokenRef, nil
	}
	log.Printf("[IMAGE-CACHE] ERROR: VMExport not ready within timeout — name: %s, timeout: %v", exportName, vmExportPollTimeout)
	return "", "", fmt.Errorf("VMExport %s not Ready within %v", exportName, vmExportPollTimeout)
}

func (m *ImageCacheManager) getExportToken(ns, secretName string) (string, error) {
	path := fmt.Sprintf("/api/v1/namespaces/%s/secrets/%s", ns, secretName)
	secret, err := m.k8s.Get(path)
	if err != nil {
		log.Printf("[IMAGE-CACHE] ERROR: failed to get export token secret — namespace: %s, secret: %s, detail: %v", ns, secretName, err)
		return "", err
	}
	data, _ := secret["data"].(map[string]interface{})
	if data == nil {
		log.Printf("[IMAGE-CACHE] ERROR: export token secret has no data — secret: %s", secretName)
		return "", fmt.Errorf("secret %s has no data", secretName)
	}
	tokenB64, _ := data["token"].(string)
	if tokenB64 == "" {
		log.Printf("[IMAGE-CACHE] ERROR: export token secret missing token field — secret: %s", secretName)
		return "", fmt.Errorf("secret %s has no token field", secretName)
	}
	decoded, err := base64.StdEncoding.DecodeString(tokenB64)
	if err != nil {
		log.Printf("[IMAGE-CACHE] ERROR: failed to decode export token — secret: %s, detail: %v", secretName, err)
		return "", fmt.Errorf("decode token: %w", err)
	}
	return string(decoded), nil
}

func (m *ImageCacheManager) deleteVMExport(ns, name string) {
	path := fmt.Sprintf("/apis/export.kubevirt.io/v1beta1/namespaces/%s/virtualmachineexports/%s", ns, name)
	if err := m.k8s.Delete(path); err != nil {
		log.Printf("[IMAGE-CACHE] warning: delete VMExport %s: %v", name, err)
	} else {
		log.Printf("[IMAGE-CACHE] Deleted VMExport %s", name)
	}
}

func (m *ImageCacheManager) deletePVC(ns, name string) {
	path := fmt.Sprintf("/api/v1/namespaces/%s/persistentvolumeclaims/%s", ns, name)
	if err := m.k8s.Delete(path); err != nil {
		log.Printf("[IMAGE-CACHE] warning: delete temp PVC %s: %v", name, err)
	} else {
		log.Printf("[IMAGE-CACHE] Deleted temp PVC %s", name)
	}
}

// ── Download + hash ─────────────────────────────────────────────────────

// downloadAndHash streams an image from the VMExport server to a local file,
// computing the SHA-256 checksum on the fly via io.MultiWriter.
func downloadAndHash(imageURL, token, destPath string) (string, int64, error) {
	client := &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			WriteBufferSize: 256 << 10,
			ReadBufferSize:  256 << 10,
		},
	}

	req, err := http.NewRequest(http.MethodGet, imageURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("x-kubevirt-export-token", token)

	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("export request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", 0, fmt.Errorf("export server returned %d: %s", resp.StatusCode, string(body))
	}

	contentLength := resp.ContentLength
	if contentLength > 0 {
		log.Printf("[IMAGE-CACHE] Download starting — expectedSize: %s (%d bytes)", humanBytes(contentLength), contentLength)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return "", 0, fmt.Errorf("create file: %w", err)
	}
	defer f.Close()

	hasher := sha256.New()
	dest := io.MultiWriter(f, hasher)

	downloadStart := time.Now()
	var totalWritten int64
	buf := make([]byte, 256<<10)
	lastLog := downloadStart
	for {
		nr, readErr := resp.Body.Read(buf)
		if nr > 0 {
			nw, writeErr := dest.Write(buf[:nr])
			if writeErr != nil {
				return "", 0, fmt.Errorf("write failed after %d bytes: %w", totalWritten, writeErr)
			}
			totalWritten += int64(nw)

			if time.Since(lastLog) >= 30*time.Second {
				elapsed := time.Since(downloadStart)
				if contentLength > 0 {
					pct := float64(totalWritten) / float64(contentLength) * 100
					log.Printf("[IMAGE-CACHE] Download progress — downloaded: %s / %s (%.1f%%), elapsed: %v",
						humanBytes(totalWritten), humanBytes(contentLength), pct, elapsed.Round(time.Second))
				} else {
					log.Printf("[IMAGE-CACHE] Download progress — downloaded: %s, elapsed: %v",
						humanBytes(totalWritten), elapsed.Round(time.Second))
				}
				lastLog = time.Now()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return "", 0, fmt.Errorf("read failed after %d bytes: %w", totalWritten, readErr)
		}
	}

	elapsed := time.Since(downloadStart)
	log.Printf("[IMAGE-CACHE] Download complete — size: %s (%d bytes), duration: %v", humanBytes(totalWritten), totalWritten, elapsed.Round(time.Second))

	return hex.EncodeToString(hasher.Sum(nil)), totalWritten, nil
}

// extractInternalDownloadURL picks the raw image URL from VMExport status.links.internal.
func extractInternalDownloadURL(status map[string]interface{}) (string, error) {
	links, _ := status["links"].(map[string]interface{})
	if links == nil {
		return "", fmt.Errorf("no links in VMExport status")
	}
	internal, _ := links["internal"].(map[string]interface{})
	if internal == nil {
		return "", fmt.Errorf("no internal links")
	}
	volumes, _ := internal["volumes"].([]interface{})
	if len(volumes) == 0 {
		return "", fmt.Errorf("no volumes in internal links")
	}

	vol, _ := volumes[0].(map[string]interface{})
	formats, _ := vol["formats"].([]interface{})

	for _, f := range formats {
		fo, _ := f.(map[string]interface{})
		if fmtStr, _ := fo["format"].(string); fmtStr == "raw" {
			if u, _ := fo["url"].(string); u != "" {
				return u, nil
			}
		}
	}
	for _, f := range formats {
		fo, _ := f.(map[string]interface{})
		if u, _ := fo["url"].(string); u != "" {
			log.Printf("[IMAGE-CACHE] No raw format available, falling back to format: %v", fo["format"])
			return u, nil
		}
	}
	return "", fmt.Errorf("no download URL in VMExport formats")
}

// ── Helpers ─────────────────────────────────────────────────────────────

func (m *ImageCacheManager) setPhase(record *CachedImage, phase CachePhase) {
	m.mu.Lock()
	record.Phase = phase
	m.mu.Unlock()
}

func (m *ImageCacheManager) setError(record *CachedImage, msg string) {
	log.Printf("[IMAGE-CACHE] ERROR %s: %s", record.Name, msg)
	m.mu.Lock()
	record.Phase = CachePhaseError
	record.Error = msg
	m.mu.Unlock()
}

func humanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}
