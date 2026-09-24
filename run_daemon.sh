#!/usr/bin/env bash
# run_daemon.sh - Run background automation daemon for Follow-up Suite
# Automatically scans every 15 minutes, listens for on-demand UI requests, and safely dispatches queued follow-ups

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo " Starting Teshrij Follow-up Suite Automation Loop"
echo " Periodic Scan: Every 15 minutes"
echo " On-Demand UI Trigger: Active"
echo " Queue Dispatcher: Active (1.5s delay)"
echo "=================================================="

exec python3 core/server_scanner.py --daemon
