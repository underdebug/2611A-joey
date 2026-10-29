#!/bin/bash

REPO="https://github.com/underdebug/2610-TestCode.git"
NAME="2610-TestCode"

if [[ -n "$1" ]]; then
    NAME="${NAME}${1}"
fi

git clone --recursive "$REPO" "$NAME"
