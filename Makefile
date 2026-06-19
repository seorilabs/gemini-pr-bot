IMAGE ?= registry.vzyx.xyz/seorilabs/seori-pr-bot
TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M)
PLATFORM ?= linux/arm64

.PHONY: check build docker-build docker-push deploy

check:
	npm run check

build:
	npm run build

docker-build:
	docker buildx build --platform $(PLATFORM) -t $(IMAGE):$(TAG) .

docker-push:
	docker buildx build --platform $(PLATFORM) -t $(IMAGE):$(TAG) -t $(IMAGE):latest --push .

deploy:
	kubectl apply -k k8s

