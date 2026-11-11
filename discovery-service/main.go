package main

import (
	"context"
	"flag"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/server"
)

// extension is the catalog id, used for the cluster policy's per-extension auth mode.
const extension = "oct-baremetal"

func main() {
	httpPort := flag.String("http-port", "8080", "plain HTTP port: image downloads for Metal3/Ironic and /healthz only")
	httpsPort := flag.String("https-port", "8443", "HTTPS port for the API (reached through the console proxy)")
	tlsCert := flag.String("tls-cert", "/var/run/secrets/tls/tls.crt", "Path to TLS certificate")
	tlsKey := flag.String("tls-key", "/var/run/secrets/tls/tls.key", "Path to TLS key")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Image cache: PVC-backed HTTP server for bridging PVC images → Metal3.
	var cache *ImageCacheManager
	if k8sClient, err := NewK8sClient(); err != nil {
		log.Printf("[IMAGE-CACHE] K8s client unavailable (not in-cluster?): %v — image cache disabled", err)
	} else {
		cache = NewImageCacheManager(k8sClient)
		cache.allowedNamespaces = imageNamespaces()
		log.Printf("[IMAGE-CACHE] Manager initialized — cacheDir: %s, image namespaces: %v", cache.cacheDir, cache.allowedNamespaces)
	}

	// :8080 is what the image-cache Route exposes outside the cluster. It serves only
	// image files (fetched by Ironic, which has no user) and the kubelet probes.
	go func() {
		srv := &http.Server{
			Addr:              ":" + *httpPort,
			Handler:           imageMux(cache),
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       10 * time.Second,
			WriteTimeout:      30 * time.Minute, // multi-GB images
			IdleTimeout:       120 * time.Second,
		}
		log.Printf("Starting image server on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("image server: %v", err)
		}
	}()

	// :8443 is the API, reached only through the console proxy with the user's token
	// (ConsolePlugin authorization: UserToken). Every route is checked with the
	// caller's permissions (backend-security-kit). Existing extensions ship
	// AUTH_MODE=audit until a cluster admin enables enforce in the cluster policy.
	kc, err := kubeclient.InCluster()
	if err != nil {
		log.Fatalf("kubeclient: %v", err)
	}
	policy := auth.NewPolicySource(kc, 0, logger)
	go policy.Run(ctx)
	authz, err := auth.New(auth.Options{
		Extension: extension,
		Mode:      auth.ModeFromEnv(),
		Client:    kc,
		Policy:    policy,
		Logger:    logger,
	}, apiRoutes(cache))
	if err != nil {
		log.Fatalf("permission table: %v", err)
	}
	if err := server.Run(ctx, server.Config{
		Addr:       ":" + *httpsPort,
		CertFile:   *tlsCert,
		KeyFile:    *tlsKey,
		HealthAddr: "-", // /healthz is on the image port
		Handler:    authz.Handler(),
		Logger:     logger,
		// Discovery makes several Redfish calls with 30 s timeouts each against a BMC
		// that may be slow; the kit's 120 s default could cut it off.
		WriteTimeout: 10 * time.Minute,
	}); err != nil {
		log.Fatalf("API server: %v", err)
	}
}

func bmh(verb string, ns auth.Extractor) auth.Check {
	return auth.Check{Verb: verb, Group: "metal3.io", Resource: "baremetalhosts", Namespace: ns}
}

// apiRoutes is the permission table: what the caller must be allowed to do for each
// route, and the handler that runs after the check.
func apiRoutes(cache *ImageCacheManager) []auth.Route {
	routes := []auth.Route{
		// Discovery makes this backend talk to a BMC address the caller chooses, so only
		// someone who may register hosts in the target namespace may use it.
		{Pattern: "POST /api/v1/discover", Handler: http.HandlerFunc(handleDiscover),
			Checks: []auth.Check{bmh("create", auth.JSONField("namespace", ""))}},
		{Pattern: "POST /api/v1/log", Handler: http.HandlerFunc(handleLog),
			Checks: []auth.Check{bmh("list", nil)}},
	}
	if cache == nil {
		return routes
	}
	// The image cache is shared by the whole cluster: reading it needs a cluster-wide
	// view of hosts, changing it the right to create hosts anywhere, and preparing an
	// image also read access to its DataSource.
	return append(routes,
		auth.Route{Pattern: "POST /api/v1/image-cache/prepare", Handler: http.HandlerFunc(cache.handlePrepare),
			Checks: []auth.Check{
				bmh("create", nil),
				{Verb: "get", Group: "cdi.kubevirt.io", Resource: "datasources", Namespace: auth.JSONField("namespace", defaultOSImagesNS)},
			}},
		auth.Route{Pattern: "GET /api/v1/image-cache/status/{name}", Handler: http.HandlerFunc(cache.handleStatus),
			Checks: []auth.Check{bmh("list", nil)}},
		auth.Route{Pattern: "GET /api/v1/image-cache/list", Handler: http.HandlerFunc(cache.handleList),
			Checks: []auth.Check{bmh("list", nil)}},
		auth.Route{Pattern: "DELETE /api/v1/image-cache/{name}", Handler: http.HandlerFunc(cache.handleDelete),
			Checks: []auth.Check{bmh("create", nil)}},
	)
}

// imageMux serves the plain-HTTP port: image files and health, nothing else.
func imageMux(cache *ImageCacheManager) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	if cache != nil {
		mux.HandleFunc("GET /api/v1/image-cache/images/{filename}", cache.handleServeFile)
	}
	return mux
}

// imageNamespaces lists the namespaces prepare may export images from
// (IMAGE_NAMESPACES, comma-separated; default openshift-virtualization-os-images).
func imageNamespaces() []string {
	var out []string
	for _, ns := range strings.Split(os.Getenv("IMAGE_NAMESPACES"), ",") {
		if ns = strings.TrimSpace(ns); ns != "" {
			out = append(out, ns)
		}
	}
	if len(out) == 0 {
		out = []string{defaultOSImagesNS}
	}
	return out
}
