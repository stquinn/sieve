FROM registry-mirror.image-repository.svc.cluster.local:5002/stephen/ci-base:latest
COPY flake.nix flake.lock /src/
RUN nix flake archive path:/src >/dev/null && nix develop path:/src --profile /nix/var/nix/profiles/ci-shell -c true
