#!/bin/sh
# Strip AI co-author trailers from the message in "$1".
exec {python} {kit_dir}/kit_identity.py commit-msg "$1"
