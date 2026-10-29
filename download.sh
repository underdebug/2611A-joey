#!/bin/bash

REPO="https://github.com/underdebug/2610-SpeedingUp.git"
NAME="2610-SpeedingUp"

if [[ -n "$1" ]]; then
    NAME="${NAME}${1}"
fi

git clone --recursive "$REPO" "$NAME"
