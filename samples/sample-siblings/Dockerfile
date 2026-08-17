FROM python:3.12-slim

# Baked at build time, so reading it back proves the build context came from
# this project's directory rather than from wherever the daemon happens to run.
COPY marker.txt /baked-marker.txt
