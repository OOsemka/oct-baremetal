package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// K8sClient is a lightweight Kubernetes API client using the in-cluster
// service account token. It avoids pulling in client-go and its large
// dependency tree.
type K8sClient struct {
	baseURL   string
	tokenPath string
	client    *http.Client
}

func NewK8sClient() (*K8sClient, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("KUBERNETES_SERVICE_HOST/PORT not set — not running in-cluster")
	}

	tokenPath := "/var/run/secrets/kubernetes.io/serviceaccount/token"
	if _, err := os.Stat(tokenPath); err != nil {
		return nil, fmt.Errorf("service account token not found: %w", err)
	}

	return &K8sClient{
		baseURL:   fmt.Sprintf("https://%s:%s", host, port),
		tokenPath: tokenPath,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: true, // in-cluster API server
					MinVersion:         tls.VersionTLS12,
				},
			},
		},
	}, nil
}

func (c *K8sClient) token() (string, error) {
	data, err := os.ReadFile(c.tokenPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (c *K8sClient) request(method, path string, body interface{}) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}

	tok, err := c.token()
	if err != nil {
		return nil, 0, fmt.Errorf("read SA token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(resp.Body)
	return respData, resp.StatusCode, err
}

func (c *K8sClient) Get(path string) (map[string]interface{}, error) {
	data, code, err := c.request(http.MethodGet, path, nil)
	if err != nil {
		log.Printf("[IMAGE-CACHE] K8s GET failed — path: %s, detail: %v", path, err)
		return nil, err
	}
	if code < 200 || code >= 300 {
		log.Printf("[IMAGE-CACHE] K8s GET error response — path: %s, status: %d", path, code)
		return nil, fmt.Errorf("GET %s → %d: %s", path, code, truncate(string(data), 200))
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	return result, nil
}

func (c *K8sClient) Create(path string, obj map[string]interface{}) (map[string]interface{}, error) {
	kind, _ := obj["kind"].(string)
	if meta, ok := obj["metadata"].(map[string]interface{}); ok {
		name, _ := meta["name"].(string)
		log.Printf("[IMAGE-CACHE] K8s CREATE — kind: %s, name: %s, path: %s", kind, name, path)
	}
	data, code, err := c.request(http.MethodPost, path, obj)
	if err != nil {
		log.Printf("[IMAGE-CACHE] K8s CREATE failed — path: %s, detail: %v", path, err)
		return nil, err
	}
	if code < 200 || code >= 300 {
		log.Printf("[IMAGE-CACHE] K8s CREATE error response — path: %s, status: %d", path, code)
		return nil, fmt.Errorf("POST %s → %d: %s", path, code, truncate(string(data), 200))
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	return result, nil
}

func (c *K8sClient) Delete(path string) error {
	log.Printf("[IMAGE-CACHE] K8s DELETE — path: %s", path)
	_, code, err := c.request(http.MethodDelete, path, nil)
	if err != nil {
		log.Printf("[IMAGE-CACHE] K8s DELETE failed — path: %s, detail: %v", path, err)
		return err
	}
	if code >= 300 && code != 404 {
		log.Printf("[IMAGE-CACHE] K8s DELETE error response — path: %s, status: %d", path, code)
		return fmt.Errorf("DELETE %s → %d", path, code)
	}
	return nil
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
