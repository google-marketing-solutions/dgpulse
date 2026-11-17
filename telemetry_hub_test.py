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

"""Tests for the Telemetry Hub (Tadau) integration.

Run from this directory: ``python -m pytest``. No network: the GA4 call is
mocked.
"""

import json
import types
from unittest import mock

import pytest
from gaarf import api_clients
from gaarf import report_fetcher

import telemetry_hub

_ENV = {
    'TELEMETRY_HUB_API_SECRET': 'secret',
    'TELEMETRY_HUB_MEASUREMENT_ID': 'G-TEST',
    'TELEMETRY_HUB_OPT_IN': 'true',
}


@pytest.fixture(name='sent')
def _sent_fixture():
  """Captures GA4 Measurement Protocol payloads instead of sending them."""
  payloads = []

  def fake_post(url, data):  # pylint: disable=unused-argument
    payloads.append(json.loads(data))
    return types.SimpleNamespace(raise_for_status=lambda: None)

  with mock.patch(
      'tadau.measurement_protocol.requests.post',
      autospec=True,
      side_effect=fake_post,
  ):
    yield payloads


@pytest.mark.parametrize(
    'raw, expected',
    [
        (1234567890, '123-456-7890'),
        ('1234567890', '123-456-7890'),
        ('123-456-7890', '123-456-7890'),
        ('12345', None),
        ('abc', None),
    ],
)
def test_format_external_customer_id(raw, expected):
  assert telemetry_hub.format_external_customer_id(raw) == expected


@pytest.mark.parametrize(
    'url, expected',
    [
        ('https://example.com/opportunity/123456789', '123456789'),
        ('https://x/opp/1234567890?tab=1', '1234567890'),
        ('https://x/account/123/opportunity/87654321', '87654321'),
        ('98765432', '98765432'),
        ('https://x/opportunity/1234567', None),  # Too short.
        ('', None),
        (None, None),
    ],
)
def test_parse_opportunity_id(url, expected):
  assert telemetry_hub.parse_opportunity_id(url) == expected


def test_resolve_opportunity_id_prefers_explicit(monkeypatch):
  monkeypatch.setenv('ROPPS_URL', 'https://x/opportunity/111111111')
  assert telemetry_hub.resolve_opportunity_id() == '111111111'
  monkeypatch.setenv('OPPORTUNITY_ID', '222222222')
  assert telemetry_hub.resolve_opportunity_id() == '222222222'


def test_build_client_without_credentials(monkeypatch):
  monkeypatch.setenv('TELEMETRY_HUB_OPT_IN', 'true')
  monkeypatch.delenv('TELEMETRY_HUB_API_SECRET', raising=False)
  monkeypatch.delenv('TELEMETRY_HUB_MEASUREMENT_ID', raising=False)
  assert telemetry_hub.build_tadau_client() is None


def test_build_client_opt_out(monkeypatch):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  monkeypatch.setenv('TELEMETRY_HUB_OPT_IN', 'false')
  assert telemetry_hub.build_tadau_client() is None


def test_build_client_defaults_to_opt_out(monkeypatch):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  monkeypatch.delenv('TELEMETRY_HUB_OPT_IN', raising=False)
  assert telemetry_hub.build_tadau_client() is None


def test_send_solution_usage_payload(monkeypatch, sent):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  client = telemetry_hub.build_tadau_client()

  assert telemetry_hub.send_solution_usage(client, 1234567890, '123456789')

  assert len(sent) == 1
  event = sent[0]['events'][0]
  assert event['name'] == 'SOLUTION_USAGE'
  params = dict(event['params'])
  # Required by Telemetry Hub: random per-event ID (UUID4, 36 chars).
  external_event_id = params.pop('external_event_id')
  assert len(external_event_id) == 36
  assert params == {
      # Must match a registered app_name in Telemetry Hub
      'app': 'Demand Gen Pulse',
      'is_agent_event': False,
      'non_personalized_ads': False,
      'th_google_ads_customer_id': '123-456-7890',
      'th_opportunity_id': '123456789',
  }
  assert sent[0]['non_personalized_ads'] is True


def test_external_event_id_is_unique_per_event(monkeypatch, sent):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  client = telemetry_hub.build_tadau_client()

  telemetry_hub.send_solution_usage(client, 1234567890)
  telemetry_hub.send_solution_usage(client, 1234567890)

  ids = {
      payload['events'][0]['params']['external_event_id'] for payload in sent
  }
  assert len(ids) == 2


def test_send_solution_usage_without_opportunity(monkeypatch, sent):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  client = telemetry_hub.build_tadau_client()

  assert telemetry_hub.send_solution_usage(client, '9876543210')

  assert 'th_opportunity_id' not in sent[0]['events'][0]['params']


def test_send_solution_usage_is_fail_open(monkeypatch):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  client = telemetry_hub.build_tadau_client()
  with mock.patch(
      'tadau.measurement_protocol.requests.post',
      autospec=True,
      side_effect=RuntimeError('network down'),
  ):
    # Tadau logs and swallows; our wrapper must not raise either.
    telemetry_hub.send_solution_usage(client, 1234567890)

  assert not telemetry_hub.send_solution_usage(None, 1234567890)
  assert not telemetry_hub.send_solution_usage(client, 'not-an-id')


def test_send_for_accounts_counts_and_uses_env_opportunity(monkeypatch, sent):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  monkeypatch.setenv('ROPPS_URL', 'https://x/opportunity/123456789')

  count = telemetry_hub.send_solution_usage_for_accounts(
      ['1234567890', 'bad', 9876543210]
  )

  assert count == 2
  assert all(
      payload['events'][0]['params']['th_opportunity_id'] == '123456789'
      for payload in sent
  )


def test_send_for_accounts_exits_early_without_client(monkeypatch, sent):
  for key, value in _ENV.items():
    monkeypatch.setenv(key, value)
  monkeypatch.setenv('TELEMETRY_HUB_OPT_IN', 'false')

  with mock.patch.object(
      telemetry_hub, 'resolve_opportunity_id', autospec=True
  ) as resolve_opportunity_id:
    count = telemetry_hub.send_solution_usage_for_accounts(['1234567890'])

  assert count == 0
  assert not sent
  resolve_opportunity_id.assert_not_called()


def test_fetch_demand_gen_accounts_uses_gaarf(tmp_path):
  ads_config = tmp_path / 'google-ads.yaml'
  ads_config.write_text('# comment\nlogin_customer_id: 123-456-7890\n')
  query = tmp_path / 'get-accounts.sql'
  query.write_text('SELECT customer.id FROM campaign')

  with (
      mock.patch.object(api_clients, 'GoogleAdsApiClient', autospec=True),
      mock.patch.object(
          report_fetcher.AdsReportFetcher,
          'expand_mcc',
          autospec=True,
          return_value=[2222222222, 1111111111, 2222222222],
      ) as expand_mcc,
  ):
    accounts = telemetry_hub.fetch_demand_gen_accounts(
        str(ads_config), str(query)
    )

  assert accounts == ['1111111111', '2222222222']
  # With autospec, the patched method also records the instance (``self``).
  expand_mcc.assert_called_once_with(
      mock.ANY, '1234567890', 'SELECT customer.id FROM campaign'
  )


def test_fetch_demand_gen_accounts_is_fail_open(tmp_path):
  assert not telemetry_hub.fetch_demand_gen_accounts(
      str(tmp_path / 'missing.yaml'), str(tmp_path / 'missing.sql')
  )


def test_main_always_exits_zero(monkeypatch):
  # Discovery and sending both explode: the installer must still see 0.
  monkeypatch.setattr(
      telemetry_hub,
      'fetch_demand_gen_accounts',
      mock.Mock(side_effect=RuntimeError('boom')),
  )
  assert telemetry_hub.main(['telemetry_hub.py']) == 0

  monkeypatch.setattr(
      telemetry_hub,
      'send_solution_usage_for_accounts',
      mock.Mock(side_effect=RuntimeError('boom')),
  )
  assert telemetry_hub.main(['telemetry_hub.py', '1234567890']) == 0
