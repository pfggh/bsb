"""
Interactive Review & Edit Terminal User Interface (TUI).
Split screen: Left pane displays conversation history,
Right pane displays contact info, AI reasoning, draft follow-up, and action buttons.
Allows Validate [V], Edit/Modify [E], Cancel [C], Navigation [N/P/arrows], and Exit [Q].
Automatically saves user feedback into the continuous learning RAG system upon action.
"""

import curses
import textwrap
from typing import List, Dict, Any, Optional
from core.db import get_db_connection, DEFAULT_DB_PATH
from core.learning import record_feedback
from core.sender import queue_draft_for_sending
from core.analyzer import format_chat_transcript, summarize_transcript


def get_pending_drafts(db_path: str = DEFAULT_DB_PATH) -> List[Dict[str, Any]]:
    """Fetches all PENDING follow-up drafts for review."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT f.id, f.contact, f.drafted_msg, f.reasoning, f.intent, f.status,
           f.decision, f.category, f.rule_ids, f.internal_reason,
           f.required_human_action, f.not_before,
           c.profile_name, c.last_interaction, c.total_messages
    FROM followup_drafts f
    LEFT JOIN contacts c ON f.contact = c.contact
    WHERE f.status = 'PENDING'
    ORDER BY f.id ASC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_chat_history_for_tui(contact: str, db_path: str = DEFAULT_DB_PATH, limit: int = 100) -> List[Dict[str, Any]]:
    """Fetches recent messages for the left pane of TUI to handle long threads efficiently."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT direction, message, timestamp
    FROM (
        SELECT id, direction, message, timestamp
        FROM chats
        WHERE contact = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
    )
    ORDER BY timestamp ASC, id ASC
    """, (contact, limit))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _safe_addstr(win, y: int, x: int, text: str, attr=0):
    """Safely writes text to a curses window without crashing on resize or boundaries."""
    try:
        max_y, max_x = win.getmaxyx()
        if 0 <= y < max_y and 0 <= x < max_x:
            available = max_x - x - 1
            if available > 0:
                win.addstr(y, x, str(text)[:available], attr)
    except curses.error:
        pass


def run_tui(openai_client: Optional[Any] = None, db_path: str = DEFAULT_DB_PATH) -> None:
    """Wrapper that initializes curses and runs the TUI loop."""
    curses.wrapper(lambda stdscr: _tui_main(stdscr, openai_client, db_path))


def _prompt_input(stdscr, prompt_text: str, max_y: int, max_x: int, initial_value: str = "") -> str:
    """Simple curses prompt window for editing text or inputting cancel reasons."""
    curses.curs_set(1)
    
    # Create an input window near bottom
    win_h = 7 if initial_value else 6
    win_w = max(20, min(max_x - 4, max(50, max_x - 10)))
    win_y = max(1, (max_y - win_h) // 2)
    win_x = max(1, (max_x - win_w) // 2)
    
    try:
        win = curses.newwin(win_h, win_w, win_y, win_x)
        win.box()
        _safe_addstr(win, 1, 2, prompt_text[:win_w - 4], curses.A_BOLD)
        if initial_value:
            preview = initial_value[:win_w - 18]
            _safe_addstr(win, 2, 2, f"Current: {preview}...", curses.A_DIM)
            input_y = 4
            _safe_addstr(win, 3, 2, "Enter new text (or press Enter to keep current):", curses.A_DIM)
        else:
            input_y = 3
        
        _safe_addstr(win, input_y, 2, "> ")
        win.refresh()
        
        # Read input
        curses.echo()
        val = win.getstr(input_y, 4, max(1, win_w - 6)).decode("utf-8", errors="replace").strip()
        if not val and initial_value:
            val = initial_value
    except Exception:
        val = initial_value if initial_value else ""
    finally:
        try:
            curses.noecho()
            curses.curs_set(0)
        except curses.error:
            pass
    
    return val


def _tui_main(stdscr, openai_client: Optional[Any], db_path: str) -> None:
    curses.curs_set(0)
    curses.use_default_colors()
    
    # Color pairs
    curses.init_pair(1, curses.COLOR_CYAN, -1)     # Left pane headers / incoming
    curses.init_pair(2, curses.COLOR_GREEN, -1)    # Right pane headers / outgoing
    curses.init_pair(3, curses.COLOR_YELLOW, -1)   # Highlights / warnings
    curses.init_pair(4, curses.COLOR_RED, -1)      # Cancel
    curses.init_pair(5, curses.COLOR_WHITE, curses.COLOR_BLUE) # Title bar

    drafts = get_pending_drafts(db_path)
    current_idx = 0
    message_banner = "Welcome to Fady_bot Review TUI"

    while True:
        stdscr.clear()
        max_y, max_x = stdscr.getmaxyx()

        if max_y < 15 or max_x < 60:
            _safe_addstr(stdscr, 0, 0, "Terminal window too small. Resize to at least 80x20.", curses.color_pair(4))
            try:
                stdscr.refresh()
            except curses.error:
                pass
            ch = stdscr.getch()
            if ch == ord('q') or ch == ord('Q'):
                break
            continue

        # Header Title Bar
        title = " FADY_BOT FOLLOW-UP REVIEW TUI "
        status_bar = f" Drafts to Review: {len(drafts)} | [Q] Exit "
        title_str = title + " " * max(0, max_x - len(title) - len(status_bar)) + status_bar
        _safe_addstr(stdscr, 0, 0, title_str[:max_x], curses.color_pair(5) | curses.A_BOLD)

        if not drafts:
            empty_msg = "No pending follow-ups to review! All drafts processed."
            _safe_addstr(stdscr, max_y // 2, max(0, (max_x - len(empty_msg)) // 2), empty_msg, curses.color_pair(2) | curses.A_BOLD)
            help_msg = "Press [Q] to return to main menu."
            _safe_addstr(stdscr, (max_y // 2) + 2, max(0, (max_x - len(help_msg)) // 2), help_msg, curses.A_DIM)
            stdscr.refresh()
            ch = stdscr.getch()
            if ch == curses.KEY_RESIZE:
                curses.update_lines_cols()
                stdscr.clear()
                continue
            if ch in [ord('q'), ord('Q'), 27]:
                break
            continue

        if current_idx >= len(drafts):
            current_idx = len(drafts) - 1

        curr_draft = drafts[current_idx]
        contact = curr_draft["contact"]
        profile_name = curr_draft["profile_name"] or "Unknown"
        history = get_chat_history_for_tui(contact, db_path)

        # Pane dimensions
        split_x = max_x // 2
        content_y_start = 2
        content_h = max(2, max_y - 4)

        # ----------------- LEFT PANE: Conversation History -----------------
        left_title = f" Conversation: {contact} ({profile_name}) "
        _safe_addstr(stdscr, content_y_start - 1, 1, left_title[:split_x - 2], curses.color_pair(1) | curses.A_BOLD)
        
        # Draw vertical separator safely
        for y in range(content_y_start - 1, max(content_y_start, max_y - 2)):
            try:
                stdscr.addch(y, split_x, curses.ACS_VLINE)
            except curses.error:
                pass

        # Render chat messages inside left pane
        left_w = max(10, split_x - 2)
        rendered_lines = []
        for msg in history:
            is_incoming = (msg.get("direction") or "").upper() == "INCOMING"
            ts_str = (msg.get("timestamp") or "").strip()
            ts_display = ts_str[-8:] if len(ts_str) >= 8 else (ts_str or "--:--:--")
            sender_label = f"[{ts_display}] " + ("Customer" if is_incoming else "You")
            body = (msg.get("message") or "").strip()
            color = curses.color_pair(1) if is_incoming else curses.color_pair(2)
            
            wrapped = textwrap.wrap(f"{sender_label}: {body}", width=max(1, left_w - 2))
            for w_line in wrapped:
                rendered_lines.append((w_line, color))
            rendered_lines.append(("", curses.A_NORMAL))

        # Show bottom-most messages that fit
        visible_lines = rendered_lines[-content_h:]
        for idx, (line_text, line_color) in enumerate(visible_lines):
            _safe_addstr(stdscr, content_y_start + idx, 2, line_text[:left_w], line_color)

        # ----------------- RIGHT PANE: Proposed Draft & Actions -----------------
        right_start_x = split_x + 2
        right_w = max(10, max_x - right_start_x - 1)

        right_title = f" Draft #{current_idx + 1} of {len(drafts)} | {curr_draft.get('category') or curr_draft.get('intent', 'GENERAL')} "
        _safe_addstr(stdscr, content_y_start - 1, right_start_x, right_title[:right_w], curses.color_pair(2) | curses.A_BOLD)

        curr_y = content_y_start
        # Contact metadata
        _safe_addstr(stdscr, curr_y, right_start_x, f"Destination Phone: ", curses.A_BOLD)
        _safe_addstr(stdscr, curr_y, right_start_x + 19, f"{contact}", curses.color_pair(3) | curses.A_BOLD)
        curr_y += 1
        _safe_addstr(stdscr, curr_y, right_start_x, f"Last Interaction : {curr_draft.get('last_interaction', 'N/A')}", curses.A_DIM)
        curr_y += 1

        # Decision & Rule ID
        v2_dec = curr_draft.get("decision", "SEND")
        dec_color = curses.color_pair(2) if v2_dec == "SEND" else curses.color_pair(3)
        _safe_addstr(stdscr, curr_y, right_start_x, f"Decision: ", curses.A_BOLD)
        _safe_addstr(stdscr, curr_y, right_start_x + 10, f"[{v2_dec}]", dec_color | curses.A_BOLD)

        rule_ids_raw = curr_draft.get("rule_ids") or "[]"
        try:
            r_list = json.loads(rule_ids_raw) if isinstance(rule_ids_raw, str) else rule_ids_raw
            r_str = ", ".join(r_list) if r_list else "None"
        except Exception:
            r_str = str(rule_ids_raw)
        _safe_addstr(stdscr, curr_y, right_start_x + 24, f"Rules: {r_str[:max(1, right_w - 26)]}", curses.A_DIM)
        curr_y += 2

        # AI Reasoning
        _safe_addstr(stdscr, curr_y, right_start_x, "AI Reasoning & Context:", curses.A_BOLD)
        curr_y += 1
        reason_text = curr_draft.get("internal_reason") or curr_draft.get("reasoning") or "No reasoning provided."
        reason_wrap = textwrap.wrap(reason_text, width=right_w)
        for r_line in reason_wrap[:3]:
            _safe_addstr(stdscr, curr_y, right_start_x, r_line[:right_w], curses.color_pair(3))
            curr_y += 1
        curr_y += 1

        # Proposed Draft Message
        _safe_addstr(stdscr, curr_y, right_start_x, "Proposed WhatsApp Follow-up Message:", curses.A_BOLD)
        curr_y += 1
        
        # Border around draft message
        draft_text = curr_draft.get("drafted_msg") or "(No message drafted)"
        msg_wrap = textwrap.wrap(draft_text, width=max(1, right_w - 4))
        max_draft_lines = max(0, max_y - curr_y - 5)
        if max_draft_lines > 0 and len(msg_wrap) > max_draft_lines:
            msg_wrap = msg_wrap[:max_draft_lines]
            msg_wrap.append("[... preview truncated ...]")
        elif max_draft_lines == 0:
            msg_wrap = ["[... preview truncated ...]"]

        _safe_addstr(stdscr, curr_y, right_start_x, "┌" + "─" * max(0, right_w - 2) + "┐", curses.A_DIM)
        curr_y += 1
        for m_line in msg_wrap:
            _safe_addstr(stdscr, curr_y, right_start_x, "│ ", curses.A_DIM)
            _safe_addstr(stdscr, curr_y, right_start_x + 2, m_line[:max(1, right_w - 4)], curses.color_pair(2) | curses.A_BOLD)
            padding = max(0, (right_w - 2) - 2 - len(m_line[:max(1, right_w - 4)]))
            _safe_addstr(stdscr, curr_y, right_start_x + 2 + len(m_line[:max(1, right_w - 4)]), " " * padding + "│", curses.A_DIM)
            curr_y += 1
        _safe_addstr(stdscr, curr_y, right_start_x, "└" + "─" * max(0, right_w - 2) + "┘", curses.A_DIM)
        curr_y += 2

        # Action controls guidance
        controls = "[V] Validate   [E] Edit   [C] Cancel   [N/P] Move   [Q] Exit"
        _safe_addstr(stdscr, max_y - 2, 2, controls[:max(1, max_x - 4)], curses.color_pair(3) | curses.A_BOLD)
        
        # Message banner
        _safe_addstr(stdscr, max_y - 1, 2, message_banner[:max(1, max_x - 4)], curses.A_DIM)

        stdscr.refresh()

        # Keyboard event loop
        ch = stdscr.getch()

        if ch == curses.KEY_RESIZE:
            curses.update_lines_cols()
            stdscr.clear()
            continue
        elif ch in [ord('q'), ord('Q')]:
            break
        elif ch in [ord('n'), ord('N'), curses.KEY_RIGHT, curses.KEY_DOWN]:
            if current_idx < len(drafts) - 1:
                current_idx += 1
                message_banner = f"Moved to draft {current_idx + 1}/{len(drafts)}"
        elif ch in [ord('p'), ord('P'), curses.KEY_LEFT, curses.KEY_UP]:
            if current_idx > 0:
                current_idx -= 1
                message_banner = f"Moved to draft {current_idx + 1}/{len(drafts)}"
        elif ch in [ord('v'), ord('V')]:
            # VALIDATE / APPROVE
            msg_to_send = (curr_draft.get("drafted_msg") or "").strip()
            if not msg_to_send:
                message_banner = "Cannot approve empty draft message! Press [E] to compose a message first."
                continue

            draft_id = curr_draft["id"]
            conn = get_db_connection(db_path)
            c = conn.cursor()
            c.execute("UPDATE followup_drafts SET status = 'APPROVED', decision = 'SEND', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (draft_id,))
            conn.commit()
            conn.close()

            # Queue for sending (enforces application dispatch gates)
            qid = queue_draft_for_sending(draft_id, db_path=db_path)

            # Continuous learning record with rich conversation context
            summary = summarize_transcript(format_chat_transcript(history))
            r_ids = []
            try:
                r_ids = json.loads(curr_draft.get("rule_ids") or "[]")
            except Exception:
                pass
            record_feedback(
                contact=contact,
                context_summary=summary,
                review_action="APPROVED",
                original_draft=curr_draft.get("drafted_msg", ""),
                final_msg=curr_draft.get("drafted_msg", ""),
                reason_notes="Directly approved by reviewer without edits",
                client=openai_client,
                category=curr_draft.get("category", "sales"),
                decision="SEND",
                original_decision=curr_draft.get("decision", "SEND"),
                corrected_decision="SEND",
                correction_type="none",
                rule_ids=r_ids,
                db_path=db_path
            )

            if qid:
                message_banner = f"Approved draft for {contact} & queued for sending!"
            else:
                message_banner = f"Approved draft for {contact} (queue blocked: failed dispatch gate)."
            drafts.pop(current_idx)
            if current_idx >= len(drafts) and drafts:
                current_idx = len(drafts) - 1

        elif ch in [ord('e'), ord('E')]:
            # MODIFY / EDIT
            initial_msg = curr_draft.get("drafted_msg", "")
            new_text = _prompt_input(stdscr, f"Edit follow-up message for {contact}:", max_y, max_x, initial_value=initial_msg)
            if new_text:
                notes = _prompt_input(stdscr, "Reason for modification (teaches the AI):", max_y, max_x)
                draft_id = curr_draft["id"]
                conn = get_db_connection(db_path)
                c = conn.cursor()
                c.execute("""
                UPDATE followup_drafts
                SET drafted_msg = ?, status = 'MODIFIED', decision = 'SEND', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """, (new_text, draft_id))
                conn.commit()
                conn.close()

                # Queue for sending
                qid = queue_draft_for_sending(draft_id, db_path=db_path)

                # Record learning with rich conversation context
                summary = summarize_transcript(format_chat_transcript(history))
                r_ids = []
                try:
                    r_ids = json.loads(curr_draft.get("rule_ids") or "[]")
                except Exception:
                    pass
                record_feedback(
                    contact=contact,
                    context_summary=summary,
                    review_action="MODIFIED",
                    original_draft=curr_draft.get("drafted_msg", ""),
                    final_msg=new_text,
                    reason_notes=notes or "Modified by reviewer",
                    client=openai_client,
                    category=curr_draft.get("category", "sales"),
                    decision="SEND",
                    original_decision=curr_draft.get("decision", "SEND"),
                    corrected_decision="SEND",
                    correction_type="wording",
                    rule_ids=r_ids,
                    db_path=db_path
                )

                if qid:
                    message_banner = f"Modified message for {contact}, queued & recorded learning rule!"
                else:
                    message_banner = f"Modified message for {contact} (saved; queue blocked by dispatch gate)."
                drafts.pop(current_idx)
                if current_idx >= len(drafts) and drafts:
                    current_idx = len(drafts) - 1
            else:
                message_banner = "Edit cancelled (empty message)."

        elif ch in [ord('c'), ord('C')]:
            # CANCEL / NO MESSAGE (SKIP)
            cancel_reason = _prompt_input(stdscr, f"Reason for cancelling follow-up for {contact}:", max_y, max_x)
            draft_id = curr_draft["id"]
            conn = get_db_connection(db_path)
            c = conn.cursor()
            c.execute("""
            UPDATE followup_drafts
            SET status = 'CANCELLED', decision = 'SKIP', cancel_reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """, (cancel_reason or "Cancelled by user", draft_id))
            conn.commit()
            conn.close()

            # Record learning negative rule with rich conversation context
            summary = summarize_transcript(format_chat_transcript(history))
            r_ids = []
            try:
                r_ids = json.loads(curr_draft.get("rule_ids") or "[]")
            except Exception:
                pass
            record_feedback(
                contact=contact,
                context_summary=summary,
                review_action="CANCELLED",
                original_draft=curr_draft.get("drafted_msg", ""),
                final_msg="",
                reason_notes=cancel_reason or "Cancelled by reviewer",
                client=openai_client,
                category=curr_draft.get("category", "sales"),
                decision="SKIP",
                original_decision=curr_draft.get("decision", "SKIP"),
                corrected_decision="SKIP",
                correction_type="eligibility",
                rule_ids=r_ids,
                db_path=db_path
            )

            message_banner = f"Cancelled follow-up for {contact} & updated AI memory rule."
            drafts.pop(current_idx)
            if current_idx >= len(drafts) and drafts:
                current_idx = len(drafts) - 1

