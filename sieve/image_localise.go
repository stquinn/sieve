package sieve

import (
	"crypto/md5"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var remoteImgPattern = regexp.MustCompile(`!\[([^\]]*)\]\((https?://[^)]+)\)`)

// localiseImages scans content for remote image URLs, fetches each one with a
// plain HTTP GET, saves to docDir/.assets/, and rewrites the URL to a relative
// path. Images that fail to fetch are left with their original remote URL.
func localiseImages(content, docDir string) string {
	return remoteImgPattern.ReplaceAllStringFunc(content, func(match string) string {
		m := remoteImgPattern.FindStringSubmatch(match)
		if len(m) < 3 {
			return match
		}
		alt, imgURL := m[1], m[2]
		localPath, err := fetchAndSaveImage(imgURL, filepath.Join(docDir, ".assets"))
		if err != nil {
			return match
		}
		rel, err := filepath.Rel(docDir, localPath)
		if err != nil {
			return match
		}
		return fmt.Sprintf("![%s](%s)", alt, rel)
	})
}

func fetchAndSaveImage(imgURL, assetsDir string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(imgURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	ext := extensionFromContentType(resp.Header.Get("Content-Type"))
	hash := fmt.Sprintf("%x", md5.Sum([]byte(imgURL)))[:8]
	filename := "img-" + hash + ext

	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return "", err
	}
	outPath := filepath.Join(assetsDir, filename)
	return outPath, os.WriteFile(outPath, data, 0644)
}

func extensionFromContentType(ct string) string {
	switch {
	case strings.Contains(ct, "jpeg"), strings.Contains(ct, "jpg"):
		return ".jpg"
	case strings.Contains(ct, "gif"):
		return ".gif"
	case strings.Contains(ct, "webp"):
		return ".webp"
	case strings.Contains(ct, "svg"):
		return ".svg"
	default:
		return ".png"
	}
}
