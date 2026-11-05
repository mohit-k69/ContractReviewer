# Mirrors the official ClamAV image into YOUR Artifact Registry so that Cloud Run pulls it from there (and so the
# version you run is the one you built, not whatever Docker Hub serves later). Build with:
#   gcloud builds submit scanner-service/clamav --tag REGION-docker.pkg.dev/PROJECT_ID/contract-scanner/clamav:1.4
# The official image runs clamd (TCP 3310) and the freshclam signature updater.
FROM clamav/clamav:1.4
