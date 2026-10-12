"""
core/http_client.py - Resilient HTTP client with exponential backoff and jitter.

Provides post_with_retry for BestSMSBulk and external API calls with structured
logging, handling retryable HTTP status codes and network drops.
"""

import logging
import random
import time
from typing import Any, Dict, Optional, Tuple, Union

import requests

logger = logging.getLogger("followup.http_client")

RETRYABLE_STATUS_CODES: Tuple[int, ...] = (429, 500, 502, 503, 504)
NON_RETRYABLE_STATUS_CODES: Tuple[int, ...] = (400, 401, 403, 404)


def post_with_retry(
    url: str,
    json_data: Optional[Dict[str, Any]] = None,
    data: Optional[Union[Dict[str, Any], str, bytes]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 15,
    max_retries: int = 3,
    base_delay: float = 1.0,
    session: Optional[requests.Session] = None,
    **kwargs: Any
) -> requests.Response:
    """
    Executes an HTTP POST request with exponential backoff and jitter for retryable failures.

    Args:
        url: Destination HTTP URL.
        json_data: JSON payload dictionary to send in request body.
        data: Raw or form data to send in request body.
        headers: Optional dictionary of HTTP headers.
        timeout: Request timeout in seconds (default: 15).
        max_retries: Maximum number of retry attempts (default: 3).
        base_delay: Base delay multiplier in seconds (default: 1.0).
        session: Optional requests.Session instance to use.

    Returns:
        requests.Response object from the successful or terminal request.

    Raises:
        requests.exceptions.RequestException: If network errors persist after max_retries.
    """
    post_func = session.post if session is not None else requests.post

    # Support json passed via kwargs or json_data parameter
    if json_data is None and "json" in kwargs:
        json_data = kwargs.pop("json")

    req_kwargs: Dict[str, Any] = {"timeout": timeout}
    if json_data is not None:
        req_kwargs["json"] = json_data
    if data is not None:
        req_kwargs["data"] = data
    if headers is not None:
        req_kwargs["headers"] = headers
    req_kwargs.update(kwargs)

    last_response: Optional[requests.Response] = None
    last_exception: Optional[Exception] = None

    for attempt in range(max_retries + 1):
        is_last_attempt = (attempt == max_retries)
        logger.info(
            "HTTP POST attempt %d/%d to %s",
            attempt + 1,
            max_retries + 1,
            url
        )

        try:
            resp = post_func(url, **req_kwargs)
            last_response = resp

            # Non-retryable status codes terminate immediately without retry
            if resp.status_code in NON_RETRYABLE_STATUS_CODES:
                logger.warning(
                    "HTTP POST to %s returned non-retryable status %d (attempt %d/%d). Terminating.",
                    url,
                    resp.status_code,
                    attempt + 1,
                    max_retries + 1
                )
                return resp

            # Retryable status codes (429, 500, 502, 503, 504)
            if resp.status_code in RETRYABLE_STATUS_CODES:
                if is_last_attempt:
                    logger.error(
                        "HTTP POST to %s exhausted all %d retries. Final status: %d",
                        url,
                        max_retries,
                        resp.status_code
                    )
                    return resp

                delay = base_delay * (2 ** attempt) + random.uniform(0.0, 0.5)
                logger.warning(
                    "HTTP POST to %s failed with retryable status %d (attempt %d/%d). Retrying in %.2fs...",
                    url,
                    resp.status_code,
                    attempt + 1,
                    max_retries + 1,
                    delay
                )
                time.sleep(delay)
                continue

            # Success or other unclassified response (e.g. 200, 201)
            logger.info(
                "HTTP POST to %s succeeded on attempt %d with status %d",
                url,
                attempt + 1,
                resp.status_code
            )
            return resp

        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError, requests.exceptions.RequestException) as exc:
            last_exception = exc
            if is_last_attempt:
                logger.error(
                    "HTTP POST to %s exhausted all %d retries due to network exception: %s",
                    url,
                    max_retries,
                    exc
                )
                raise exc

            delay = base_delay * (2 ** attempt) + random.uniform(0.0, 0.5)
            logger.warning(
                "HTTP POST to %s encountered network exception %s (attempt %d/%d). Retrying in %.2fs...",
                url,
                exc,
                attempt + 1,
                max_retries + 1,
                delay
            )
            time.sleep(delay)

    if last_response is not None:
        return last_response
    if last_exception is not None:
        raise last_exception
    raise RuntimeError(f"Unexpected exit from retry loop for {url}")
