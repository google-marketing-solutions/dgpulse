# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Telemetry Hub integration for DG Pulse (via the Tadau library).

Called once by the installer (``install_scripts/04-1-installation-completed-
tracking.sh``) when the user opted in to tracking. Emits one
``SOLUTION_USAGE`` event per Demand Gen account found by ``get-accounts.sql``,
the same query the gaarf workflow uses.

Configuration is read from environment variables so no credentials live in
code:

* ``TELEMETRY_HUB_API_SECRET``      GA4 Measurement Protocol API secret.
* ``TELEMETRY_HUB_MEASUREMENT_ID``  GA4 Measurement ID (``G-XXXXXXXXXX``).
* ``ROPPS_URL``                     Optional Connect Sales (ROpps) opportunity
                                    URL; the Opportunity ID is parsed from it.
* ``OPPORTUNITY_ID``                Optional explicit Opportunity ID; wins
                                    over ``ROPPS_URL`` when both are set.
* ``TELEMETRY_HUB_OPT_IN``          Must be ``true`` (the installer sets it
                                    from the user's consent answer); default
                                    ``false`` = nothing is sent.

Everything here is *fail-open*: a telemetry failure must never break the
installation, so every public entry point swallows and logs its exceptions
and the CLI always exits 0.

Usage::

    python3 telemetry_hub.py                       # discover accounts via gaarf
    python3 telemetry_hub.py 1234567890 987-654-3210  # explicit accounts
"""

from __future__ import annotations

import logging
import os
import re
import sys
import uuid
from collections.abc import Iterable
from typing import Any

try:
  import tadau
except ImportError:  # pragma: no cover - fail open if tadau is missing.
  tadau = None  # type: ignore[assignment]

_LOGGER = logging.getLogger(__name__)

# Must match one of the `app_names` registered for the solution in
# Telemetry Hub drops events whose `app` does not map to a registration.
APP_NAME = 'Demand Gen Pulse'
SOLUTION_USAGE_EVENT = 'SOLUTION_USAGE'

# Dimensions required by Telemetry Hub
FIXED_DIMENSIONS = {
    'app': APP_NAME,
    'is_agent_event': False,
    'non_personalized_ads': False,
}

_API_SECRET_ENV = 'TELEMETRY_HUB_API_SECRET'
_MEASUREMENT_ID_ENV = 'TELEMETRY_HUB_MEASUREMENT_ID'
_OPPORTUNITY_ID_ENV = 'OPPORTUNITY_ID'
_ROPPS_URL_ENV = 'ROPPS_URL'
_OPT_IN_ENV = 'TELEMETRY_HUB_OPT_IN'

_DEFAULT_ADS_CONFIG = os.environ.get(
    'GOOGLE_ADS_CONFIGURATION_FILE_PATH', 'google-ads.yaml'
)
_DEFAULT_ACCOUNTS_QUERY = 'get-accounts.sql'

# Telemetry Hub: Connect Sales Opportunity IDs are 8-10 digit numbers.
_OPPORTUNITY_ID_RE = re.compile(r'(?<!\d)(\d{8,10})(?!\d)')


def format_external_customer_id(customer_id: str | int) -> str | None:
  """Formats a Google Ads customer ID as an external ID (``XXX-XXX-XXXX``).

  Args:
    customer_id: A customer ID with or without hyphens (e.g. ``1234567890``
      or ``123-456-7890``).

  Returns:
    The hyphenated external customer ID, or ``None`` if the input does not
    contain exactly 10 digits.
  """
  digits = re.sub(r'\D', '', str(customer_id))
  if len(digits) != 10:
    _LOGGER.warning(
        'Telemetry Hub: unexpected customer ID %r (need 10 digits).',
        customer_id,
    )
    return None
  return f'{digits[:3]}-{digits[3:6]}-{digits[6:]}'


def parse_opportunity_id(ropps_url: str | None) -> str | None:
  """Extracts the Connect Sales Opportunity ID from a ROpps URL.

  The ID is the last standalone 8-10 digit number in the URL, e.g.
  ``.../opportunity/123456789`` or ``...?opportunityId=123456789``.

  Args:
    ropps_url: The ROpps / Connect Sales opportunity URL (or the bare ID).

  Returns:
    The Opportunity ID, or ``None`` when it cannot be determined.
  """
  if not ropps_url:
    return None
  matches = _OPPORTUNITY_ID_RE.findall(ropps_url.strip())
  if not matches:
    _LOGGER.warning(
        'Telemetry Hub: no Opportunity ID found in ROPPS_URL %r.', ropps_url
    )
    return None
  return matches[-1]


def resolve_opportunity_id() -> str | None:
  """Opportunity ID from ``OPPORTUNITY_ID``, else parsed from ``ROPPS_URL``."""
  explicit = parse_opportunity_id(os.environ.get(_OPPORTUNITY_ID_ENV))
  if explicit:
    return explicit
  return parse_opportunity_id(os.environ.get(_ROPPS_URL_ENV))


def _is_opt_in() -> bool:
  # Default is *off*: the installer exports TELEMETRY_HUB_OPT_IN=true only
  # after the user consented to tracking.
  return os.environ.get(_OPT_IN_ENV, 'false').strip().lower() in (
      'true',
      'y',
      'yes',
      '1',
  )


def build_tadau_client() -> Any:
  """Initialises the Tadau client from environment variables.

  Returns:
    A configured ``Tadau`` instance, or ``None`` when telemetry is disabled,
    misconfigured or the ``tadau`` package is unavailable. Callers must treat
    ``None`` as "telemetry off" and continue normally.
  """
  try:
    if tadau is None:
      _LOGGER.warning('Telemetry Hub: tadau is not installed; skipping.')
      return None
    if not _is_opt_in():
      _LOGGER.info('Telemetry Hub: opted out via %s.', _OPT_IN_ENV)
      return None

    api_secret = os.environ.get(_API_SECRET_ENV)
    measurement_id = os.environ.get(_MEASUREMENT_ID_ENV)
    if not api_secret or not measurement_id:
      _LOGGER.warning(
          'Telemetry Hub: %s and/or %s not set; skipping telemetry.',
          _API_SECRET_ENV,
          _MEASUREMENT_ID_ENV,
      )
      return None

    return tadau.Tadau(
        api_secret=api_secret,
        measurement_id=measurement_id,
        opt_in=True,
        # Copy: Tadau merges event params into this dict in place.
        fixed_dimensions=dict(FIXED_DIMENSIONS),
    )
  except Exception:  # pylint: disable=broad-exception-caught
    _LOGGER.exception('Telemetry Hub: failed to initialise Tadau client.')
    return None


def send_solution_usage(
    tadau_client: Any,
    customer_id: str | int,
    opportunity_id: str | None = None,
) -> bool:
  """Fires a ``SOLUTION_USAGE`` event for one Google Ads account.

  Never raises: any failure is logged and swallowed (fail-open).

  Args:
    tadau_client: Client returned by ``build_tadau_client`` (may be ``None``).
    customer_id: Google Ads customer ID, with or without hyphens.
    opportunity_id: Connect Sales Opportunity ID, if known.

  Returns:
    True if an event was handed to Tadau, False otherwise.
  """
  try:
    if tadau_client is None:
      return False

    external_customer_id = format_external_customer_id(customer_id)
    if not external_customer_id:
      return False

    event: dict[str, str] = {
        'name': SOLUTION_USAGE_EVENT,
        # Required by Telemetry Hub: random, PII-free per-event ID.
        'external_event_id': str(uuid.uuid4()),
        'th_google_ads_customer_id': external_customer_id,
    }
    if opportunity_id:
      event['th_opportunity_id'] = opportunity_id

    tadau_client.send_events([event])
    _LOGGER.info(
        'Telemetry Hub: sent %s for %s.',
        SOLUTION_USAGE_EVENT,
        external_customer_id,
    )
    return True
  except Exception:  # pylint: disable=broad-exception-caught
    _LOGGER.exception(
        'Telemetry Hub: failed to send %s for %s.',
        SOLUTION_USAGE_EVENT,
        customer_id,
    )
    return False


def send_solution_usage_for_accounts(
    customer_ids: Iterable[str | int],
    opportunity_id: str | None = None,
) -> int:
  """One client, one event per account. Returns the number of events sent."""
  tadau_client = build_tadau_client()
  if opportunity_id is None:
    opportunity_id = resolve_opportunity_id()
  return sum(
      send_solution_usage(tadau_client, customer_id, opportunity_id)
      for customer_id in customer_ids
  )


def _read_login_customer_id(ads_config_path: str) -> str | None:
  """Reads ``login_customer_id`` from google-ads.yaml (no yaml dependency)."""
  try:
    with open(ads_config_path, encoding='utf-8') as config_file:
      for line in config_file:
        line = line.strip()
        if line.startswith('login_customer_id'):
          _, _, value = line.partition(':')
          return re.sub(r'\D', '', value) or None
  except OSError:
    _LOGGER.warning('Telemetry Hub: cannot read %s.', ads_config_path)
  return None


def fetch_demand_gen_accounts(
    ads_config_path: str = _DEFAULT_ADS_CONFIG,
    customer_ids_query_path: str = _DEFAULT_ACCOUNTS_QUERY,
) -> list[str]:
  """Discovers Demand Gen accounts the same way the gaarf workflow does.

  Expands the MCC from ``google-ads.yaml`` with ``get-accounts.sql`` using
  the gaarf library (``google-ads-api-report-fetcher`` in requirements.txt).
  Fail-open: returns an empty list on any error.
  """
  try:
    # Imported lazily: gaarf is heavy and only needed for discovery.
    # pylint: disable-next=import-outside-toplevel
    from gaarf import api_clients, report_fetcher

    login_customer_id = _read_login_customer_id(ads_config_path)
    if not login_customer_id:
      _LOGGER.warning(
          'Telemetry Hub: no login_customer_id in %s; skipping discovery.',
          ads_config_path,
      )
      return []
    with open(customer_ids_query_path, encoding='utf-8') as query_file:
      customer_ids_query = query_file.read()

    fetcher = report_fetcher.AdsReportFetcher(
        api_clients.GoogleAdsApiClient(path_to_config=ads_config_path)
    )
    accounts = fetcher.expand_mcc(login_customer_id, customer_ids_query)
    return sorted({str(account) for account in accounts})
  except Exception:  # pylint: disable=broad-exception-caught
    _LOGGER.exception('Telemetry Hub: account discovery failed.')
    return []


def main(argv: list[str]) -> int:
  """CLI entry point; accounts are discovered unless given as arguments.

  Always returns 0: telemetry must never fail the installer.
  """
  try:
    logging.basicConfig(level=logging.INFO)
    customer_ids: list[str] = [arg for arg in argv[1:] if arg.strip()]
    if not customer_ids:
      customer_ids = fetch_demand_gen_accounts()
    if not customer_ids:
      _LOGGER.warning('Telemetry Hub: no customer IDs found; nothing to send.')
      return 0
    sent = send_solution_usage_for_accounts(customer_ids)
    _LOGGER.info(
        'Telemetry Hub: %d/%d %s events sent.',
        sent,
        len(customer_ids),
        SOLUTION_USAGE_EVENT,
    )
  except Exception:  # pylint: disable=broad-exception-caught
    _LOGGER.exception('Telemetry Hub: unexpected failure; ignoring.')
  return 0


if __name__ == '__main__':
  sys.exit(main(sys.argv))
