package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// configMapPublisher writes one ConfigMap per node into platform-
// system. The ConfigMap is the public contract with the backend
// `security-hardening` module — name is security-probe-<nodeName>,
// data.snapshot is the JSON-encoded Snapshot, OwnerReference points
// to the parent Node so the ConfigMap garbage-collects when the node
// is removed.
type configMapPublisher struct {
	client    kubernetes.Interface
	namespace string
	nodeName  string
}

func newConfigMapPublisher(c kubernetes.Interface, namespace, nodeName string) *configMapPublisher {
	return &configMapPublisher{client: c, namespace: namespace, nodeName: nodeName}
}

func (p *configMapPublisher) publish(ctx context.Context, snap Snapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}

	// OwnerReference back to the Node — k8s GC removes the ConfigMap
	// automatically when the Node is deleted.
	node, err := p.client.CoreV1().Nodes().Get(ctx, p.nodeName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get parent node %q: %w", p.nodeName, err)
	}
	trueVal := true
	owner := metav1.OwnerReference{
		APIVersion:         "v1",
		Kind:               "Node",
		Name:               node.Name,
		UID:                node.UID,
		BlockOwnerDeletion: &trueVal,
		Controller:         &trueVal,
	}

	name := configMapName(p.nodeName)
	desired := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: p.namespace,
			Labels: map[string]string{
				"app":                            "security-probe",
				"app.kubernetes.io/part-of":      "hosting-platform",
				"security-probe.platform/node":   p.nodeName,
			},
			OwnerReferences: []metav1.OwnerReference{owner},
		},
		Data: map[string]string{
			"snapshot": string(payload),
		},
	}

	existing, err := p.client.CoreV1().ConfigMaps(p.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("get configmap %q: %w", name, err)
		}
		_, cerr := p.client.CoreV1().ConfigMaps(p.namespace).Create(ctx, desired, metav1.CreateOptions{})
		if cerr != nil {
			// Race: another pod restart on the same node beat us to
			// the Create — try one Update.
			if apierrors.IsAlreadyExists(cerr) {
				slog.Info("configmap create race — retrying as update", "name", name)
				return p.update(ctx, name, desired)
			}
			return fmt.Errorf("create configmap %q: %w", name, cerr)
		}
		return nil
	}
	// Preserve resourceVersion for optimistic concurrency.
	desired.ResourceVersion = existing.ResourceVersion
	_, uerr := p.client.CoreV1().ConfigMaps(p.namespace).Update(ctx, desired, metav1.UpdateOptions{})
	if uerr != nil {
		return fmt.Errorf("update configmap %q: %w", name, uerr)
	}
	return nil
}

func (p *configMapPublisher) update(ctx context.Context, name string, cm *corev1.ConfigMap) error {
	existing, err := p.client.CoreV1().ConfigMaps(p.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get-for-update %q: %w", name, err)
	}
	cm.ResourceVersion = existing.ResourceVersion
	_, err = p.client.CoreV1().ConfigMaps(p.namespace).Update(ctx, cm, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("update-after-race %q: %w", name, err)
	}
	return nil
}

// configMapName composes the deterministic per-node ConfigMap name.
// Node names can be up to 253 chars; the prefix `security-probe-` is
// 15 chars so we're well inside the k8s 253-char limit.
func configMapName(nodeName string) string {
	return "security-probe-" + nodeName
}
