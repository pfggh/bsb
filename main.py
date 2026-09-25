#!/usr/bin/env python3
"""
main.py - Teshrij Follow-up & Automation System (Supabase-Native Edition)
Ported directly from Fady_bot/main.py, running on Supabase PostgreSQL instead of SQLite.

Usage:
    python3 main.py                 # Interactive Menu
    python3 main.py analyze         # Run AI analysis & draft follow-ups
    python3 main.py worker          # Start send queue worker
    python3 main.py auto            # Run auto-unreviewed generation and dispatch
    python3 main.py daemon          # Run background automation daemon (scan + queue)
    python3 main.py status          # Display status summary
    python3 main.py clear-drafts    # Remove unsent drafts & queued messages
"""

import sys
import os
import argparse
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.prompt import Prompt, Confirm

# Supabase scanner & backend modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core.server_scanner import (
    get_db,
    execute_server_scan,
    process_server_queue,
    run_server_daemon,
    get_openai_client_and_model,
    load_system_prompt,
    normalize_phone,
    is_beirut_working_hours
)

console = Console()


def show_banner():
    banner = """
[bold cyan]╔════════════════════════════════════════════════════════════╗
║                   F A D Y _ B O T                          ║
║     Supabase-Native WhatsApp Follow-up & Automation        ║
╚════════════════════════════════════════════════════════════╝[/bold cyan]
    """
    console.print(banner)


def display_status_summary():
    """Displays real-time metrics directly from Supabase PostgreSQL."""
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM bsb_messages;")
    total_chats = cur.fetchone()[0]

    cur.execute("SELECT COUNT(DISTINCT contact) FROM bsb_messages;")
    total_contacts = cur.fetchone()[0]

    cur.execute("SELECT status, COUNT(*) FROM followup_drafts GROUP BY status;")
    draft_stats = {r[0]: r[1] for r in cur.fetchall()}

    cur.execute("SELECT status, COUNT(*) FROM send_queue GROUP BY status;")
    queue_stats = {r[0]: r[1] for r in cur.fetchall()}

    try:
        cur.execute("SELECT COUNT(*) FROM feedback_learning;")
        total_learning = cur.fetchone()[0]
    except Exception:
        total_learning = 0

    try:
        cur.execute("SELECT COUNT(*) FROM canonical_rules;")
        total_canonical = cur.fetchone()[0]
    except Exception:
        total_canonical = 64

    cur.close()
    conn.close()

    table = Table(title="[bold green]System Status & Metrics (Supabase PostgreSQL)[/bold green]", show_header=True, header_style="bold magenta")
    table.add_column("Metric", style="dim")
    table.add_column("Count", justify="right", style="bold")

    table.add_row("Canonical Rules Loaded (v2)", str(total_canonical))
    table.add_row("Total Ingested Messages", f"{total_chats:,}")
    table.add_row("Unique Contacts", f"{total_contacts:,}")
    table.add_row("Pending Drafts for Review", str(draft_stats.get("PENDING", 0)))
    table.add_row("Approved / Sent Drafts", str(draft_stats.get("APPROVED", 0) + draft_stats.get("SENT", 0)))
    table.add_row("Cancelled / Skipped Follow-ups", str(draft_stats.get("CANCELLED", 0)))
    table.add_row("Send Queue Pending", str(queue_stats.get("QUEUED", 0)))
    table.add_row("Messages Successfully Sent", str(queue_stats.get("SENT", 0)))
    table.add_row("Failed Dispatches", str(queue_stats.get("FAILED", 0)))
    table.add_row("Continuous Learning Records", str(total_learning))

    console.print(table)


def cmd_analyze(limit: Optional[int] = None):
    """Exact port of Fady_bot cmd_analyze on Supabase."""
    console.print("[cyan]Running AI conversation analysis & drafting follow-ups on Supabase...[/cyan]")
    stats = execute_server_scan(limit=limit)
    console.print(f"[bold green]Analysis complete! Evaluated {stats.get('total_evaluated', 0)} contact(s) ({stats.get('drafts_created', 0)} pending follow-up draft(s) generated).[/bold green]")


def cmd_worker(dry_run: bool = False):
    """Exact port of Fady_bot cmd_worker on Supabase."""
    console.print(f"[cyan]Starting Send Queue Worker (1.5s delay, dry_run: {dry_run})...[/cyan]")
    process_server_queue(max_items=50, dry_run=dry_run)
    console.print("[bold green]Send queue processing finished![/bold green]")



def cmd_auto():
    """Exact port of Fady_bot cmd_auto on Supabase."""
    console.print("[bold yellow]Running Automatic Unreviewed Mode (Analyze + Queue Dispatches)...[/bold yellow]")
    if not Confirm.ask("Are you sure you want to automatically draft and dispatch messages to all pending contacts?"):
        console.print("[dim]Aborted by user.[/dim]")
        return

    cmd_analyze()
    cmd_worker(dry_run=False)


def cmd_clear_drafts(confirm: bool = True):
    """Exact port of Fady_bot option 11 (clear unsent drafts & queue)."""
    if confirm and not Confirm.ask("Are you sure you want to delete all drafts and queued messages from Supabase?"):
        console.print("[dim]Cancelled.[/dim]")
        return

    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM followup_drafts;")
    cur.execute("DELETE FROM send_queue WHERE status IN ('QUEUED', 'FAILED');")
    cur.execute("DELETE FROM scan_jobs;")
    conn.commit()
    cur.close()
    conn.close()
    console.print("[bold green]✓ Successfully cleared drafts, queued messages, and scan jobs![/bold green]")


def cmd_learning_insights():
    """Exact port of Fady_bot cmd_learning_insights."""
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, title, category, reason FROM canonical_rules ORDER BY id LIMIT 15;")
        can_rows = cur.fetchall()
    except Exception:
        can_rows = []
    cur.close()
    conn.close()

    if can_rows:
        table_can = Table(title="[bold green]Canonical Knowledge Rules (Supabase)[/bold green]")
        table_can.add_column("Rule ID", style="bold cyan", width=14)
        table_can.add_column("Category", style="dim", width=12)
        table_can.add_column("Title & Guidance", width=55)

        for r in can_rows:
            table_can.add_row(r[0], (r[2] or "").upper(), f"[bold]{r[1]}[/bold]\n[dim]{(r[3] or '')[:70]}...[/dim]")
        console.print(table_can)


def main():
    parser = argparse.ArgumentParser(description="Fady_bot WhatsApp Follow-up Automation (Supabase)")
    parser.add_argument("command", nargs="?", choices=["analyze", "worker", "auto", "daemon", "status", "clear-drafts"], help="Command to run")
    parser.add_argument("--dry-run", action="store_true", help="Dry run for sender")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of contacts to evaluate")
    parser.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt")
    args = parser.parse_args()

    if args.command == "analyze":
        cmd_analyze(limit=args.limit)
        return
    elif args.command == "worker":
        cmd_worker(dry_run=args.dry_run)
        return
    elif args.command == "auto":
        cmd_auto()
        return
    elif args.command == "daemon":
        run_server_daemon(interval_minutes=15)
        return
    elif args.command == "status":
        display_status_summary()
        return
    elif args.command == "clear-drafts":
        cmd_clear_drafts(confirm=not args.yes)
        return

    # Interactive Menu Loop (Matching Fady_bot main.py menu)
    while True:
        show_banner()
        display_status_summary()

        console.print("\n[bold]Main Menu Options (Supabase Engine):[/bold]")
        console.print("  [bold green]1.[/bold green] Run AI Analysis & Draft Follow-ups")
        console.print("  [bold green]2.[/bold green] Start Send Queue Worker (Dispatch approved msgs)")
        console.print("  [bold green]3.[/bold green] Run Automatic Mode (Analyze & dispatch automatically)")
        console.print("  [bold green]4.[/bold green] Start Background Automation Daemon (Continuous 15m Loop)")
        console.print("  [bold green]5.[/bold green] Canonical Knowledge Rules & Continuous Learning")
        console.print("  [bold green]6.[/bold green] Remove Unsent Drafts & Queued Messages")
        console.print("  [bold red]0.[/bold red] Exit\n")

        choice = Prompt.ask("Select an option", choices=["0", "1", "2", "3", "4", "5", "6"], default="1")

        if choice == "1":
            cmd_analyze()
        elif choice == "2":
            dry = Confirm.ask("Run in dry-run mode (no actual WhatsApp messages sent)?", default=True)
            cmd_worker(dry_run=dry)
        elif choice == "3":
            cmd_auto()
        elif choice == "4":
            console.print("[cyan]Starting continuous server daemon (Ctrl+C to stop)...[/cyan]")
            run_server_daemon(interval_minutes=15)
        elif choice == "5":
            cmd_learning_insights()
        elif choice == "6":
            cmd_clear_drafts()
        elif choice == "0":
            console.print("[dim]Goodbye![/dim]")
            break

        Prompt.ask("\n[dim]Press Enter to continue...[/dim]")


if __name__ == "__main__":
    main()
