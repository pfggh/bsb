#!/usr/bin/env bash
# run_daemon.sh - Run background automation daemon for Follow-up Suite
# Automatically scans every 15 minutes and safely dispatches queued follow-ups

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo " Starting Teshrij Follow-up Suite Automation Loop"
echo " Interval: 15 minutes"
echo "=================================================="

exec python3 automation_runner.py --daemon --interval 15
