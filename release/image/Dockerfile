# The base image for the FAKE backend, on a machine that can pull from Docker Hub (a Mac
# with Docker, CI). It is the same provisioning as the VM image, minus the kernel:
#
#   docker build -t desolate/base:latest -f release/image/Dockerfile release
#
# Where Docker Hub is out of reach (the agent's sandbox), release/image/build.sh builds the
# same thing from the Ubuntu archive and imports it.
#
# UNTESTED as of this commit: the sandbox it was written in cannot pull ubuntu:24.04.
FROM ubuntu:24.04
COPY pins.env /opt/desolate-build/pins.env
COPY image/provision.sh /opt/desolate-build/image/provision.sh
COPY image/locks /opt/desolate-build/image/locks
RUN DESOLATE_IMAGE_KIND=container bash /opt/desolate-build/image/provision.sh && rm -rf /opt/desolate-build
CMD ["sleep", "infinity"]
