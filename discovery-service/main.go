package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	httpPort := flag.String("http-port", "8080", "HTTP port for local development")
	httpsPort := flag.String("https-port", "8443", "HTTPS port for TLS serving")
	tlsCert := flag.String("tls-cert", "/var/run/secrets/tls/tls.crt", "Path to TLS certificate")
	tlsKey := flag.String("tls-key", "/var/run/secrets/tls/tls.key", "Path to TLS key")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("POST /api/v1/discover", handleDiscover)
	mux.HandleFunc("POST /api/v1/log", handleLog)

	// Image cache: PVC-backed HTTP server for bridging PVC images → Metal3
	k8sClient, k8sErr := NewK8sClient()
	if k8sErr != nil {
		log.Printf("[IMAGE-CACHE] K8s client unavailable (not in-cluster?): %v — image cache disabled", k8sErr)
	} else {
		cache := NewImageCacheManager(k8sClient)
		mux.HandleFunc("POST /api/v1/image-cache/prepare", cache.handlePrepare)
		mux.HandleFunc("GET /api/v1/image-cache/status/{name}", cache.handleStatus)
		mux.HandleFunc("GET /api/v1/image-cache/list", cache.handleList)
		mux.HandleFunc("GET /api/v1/image-cache/images/{filename}", cache.handleServeFile)
		mux.HandleFunc("DELETE /api/v1/image-cache/{name}", cache.handleDelete)
		log.Printf("[IMAGE-CACHE] Manager initialized — cacheDir: %s, routes registered", cache.cacheDir)
	}

	handler := withCORS(mux)

	// WriteTimeout is large because Metal3/Ironic downloads multi-GB images
	// through this server.
	go func() {
		addr := ":" + *httpPort
		log.Printf("Starting HTTP server on %s", addr)
		srv := &http.Server{
			Addr:         addr,
			Handler:      handler,
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 30 * time.Minute,
			IdleTimeout:  120 * time.Second,
		}
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	// Start HTTPS server if certs exist
	if _, err := os.Stat(*tlsCert); err == nil {
		addr := ":" + *httpsPort
		log.Printf("Starting HTTPS server on %s", addr)
		srv := &http.Server{
			Addr:    addr,
			Handler: handler,
			TLSConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
			},
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 30 * time.Minute,
			IdleTimeout:  120 * time.Second,
		}
		if err := srv.ListenAndServeTLS(*tlsCert, *tlsKey); err != nil {
			log.Fatalf("HTTPS server error: %v", err)
		}
	} else {
		log.Println("TLS cert not found, running HTTP only")
		select {} // block forever
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
