#!/usr/bin/env bash
set -euo pipefail

NS="garage-s3"
BUCKET="media-vault"
KEY_NAME="media-vault-rw-key"

echo "==> 1. Fetching Node IDs from all 3 Garage replicas..."
NODE0=$(kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml node id -q | cut -d'@' -f1)
NODE1=$(kubectl exec -n "$NS" garage-1 -- /garage -c /etc/garage/garage.toml node id -q | cut -d'@' -f1)
NODE2=$(kubectl exec -n "$NS" garage-2 -- /garage -c /etc/garage/garage.toml node id -q | cut -d'@' -f1)

echo "    garage-0: $NODE0"
echo "    garage-1: $NODE1"
echo "    garage-2: $NODE2"

echo "==> 2. Connecting peers over stable StatefulSet DNS..."
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml node connect "${NODE1}@garage-1.garage-headless.${NS}.svc.cluster.local:3901"
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml node connect "${NODE2}@garage-2.garage-headless.${NS}.svc.cluster.local:3901"

echo "==> 3. Assigning 3 distinct failure zones (zone-a, zone-b, zone-c) for HA..."
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml layout assign -z zone-a -c 5G "$NODE0"
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml layout assign -z zone-b -c 5G "$NODE1"
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml layout assign -z zone-c -c 5G "$NODE2"
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml layout apply --version 1

echo "==> 4. Creating bucket '${BUCKET}'..."
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml bucket create "$BUCKET" || true

echo "==> 5. Creating least-privilege key '${KEY_NAME}' (Read/Write/Delete objects, NO Owner)..."
KEY_OUTPUT=$(kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml key create "$KEY_NAME")
ACCESS_KEY=$(echo "$KEY_OUTPUT" | awk '/Key ID:/ {print $3}')
SECRET_KEY=$(echo "$KEY_OUTPUT" | awk '/Secret key:/ {print $3}')

# Grant --read (GetObject/ListObjects) and --write (PutObject/DeleteObject), explicitly omitting --owner
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml bucket allow \
  --read \
  --write \
  "$BUCKET" \
  --key "$KEY_NAME"

echo "==> 6. Storing S3 credentials in Kubernetes Secret 'media-s3-creds'..."
kubectl create secret generic media-s3-creds \
  -n "$NS" \
  --from-literal=S3_ACCESS_KEY="$ACCESS_KEY" \
  --from-literal=S3_SECRET_KEY="$SECRET_KEY" \
  --from-literal=S3_BUCKET="$BUCKET" \
  --from-literal=S3_REGION="garage" \
  --from-literal=S3_ENDPOINT="http://garage-s3.garage-s3.svc.cluster.local:3900" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Garage HA Cluster Status:"
kubectl exec -n "$NS" garage-0 -- /garage -c /etc/garage/garage.toml status
