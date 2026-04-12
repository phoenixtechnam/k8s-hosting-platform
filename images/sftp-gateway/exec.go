package main

import (
	"fmt"
	"io"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"
)

// kubeClientset is the shared Kubernetes clientset.
var (
	kubeClientset *kubernetes.Clientset
	kubeConfig    *rest.Config
)

// InitKube initialises the Kubernetes client. If kubeconfigPath is empty it
// falls back to in-cluster configuration.
func InitKube(kubeconfigPath string) error {
	var cfg *rest.Config
	var err error

	if kubeconfigPath != "" {
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfigPath)
		if err != nil {
			return fmt.Errorf("build kubeconfig from %s: %w", kubeconfigPath, err)
		}
	} else {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return fmt.Errorf("in-cluster config: %w", err)
		}
	}

	// Increase QPS for bursts of connections.
	cfg.QPS = 50
	cfg.Burst = 100

	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create kubernetes clientset: %w", err)
	}

	kubeClientset = cs
	kubeConfig = cfg
	return nil
}

// ExecInPod executes a command inside a container in the specified pod,
// streaming stdin/stdout/stderr bidirectionally.
func ExecInPod(namespace, podName, container string, command []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	req := kubeClientset.CoreV1().RESTClient().
		Post().
		Resource("pods").
		Name(podName).
		Namespace(namespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   command,
			Stdin:     stdin != nil,
			Stdout:    stdout != nil,
			Stderr:    stderr != nil,
			TTY:       false,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(kubeConfig, "POST", req.URL())
	if err != nil {
		return fmt.Errorf("create SPDY executor: %w", err)
	}

	err = executor.Stream(remotecommand.StreamOptions{
		Stdin:  stdin,
		Stdout: stdout,
		Stderr: stderr,
		Tty:    false,
	})
	if err != nil {
		return fmt.Errorf("stream exec: %w", err)
	}

	return nil
}
