#!/bin/bash

REPO="https://github.com/underdebug/2611A-joey.git"
NAME="2611A-joey"

if [[ -n "$1" ]]; then
    NAME="${NAME}${1}"
fi

git clone --recursive "$REPO" "$NAME"
