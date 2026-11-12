# TASK-04B：归一化 Schema——fixture 回归（正常/缺字段/极端价格/日期形态错 → 稳定 code）
from __future__ import annotations

import pytest

from property_radar_collectors import (
    NormalizedObservation,
    SourceRecord,
    ValidationError,
    normalize_record,
)

ARGS = dict(
    price_type="listing_ask",
    metric_code="community_ask_median_unit",
    connector_version="1.0.0-fixture",
)


def make_record(fields: dict) -> SourceRecord:
    return SourceRecord(
        source_id="src_fixture",
        object_type="community",
        object_id="c-001",
        fields=fields,
    )


def test_normal_fixture_normalizes(load_fixture) -> None:
    obs = normalize_record(make_record(load_fixture("normal_observation.json")), **ARGS)
    assert isinstance(obs, NormalizedObservation)
    assert obs.stat_date == "2026-11-01"
    assert obs.sample_count == 12
    # 元 → 分统一单位
    assert obs.price_total_fen == 320000000
    assert obs.unit_price_yuan_sqm == 40000
    assert obs.area_sqm == 80.5
    assert obs.quality_status == "valid"
    assert obs.connector_version == "1.0.0-fixture"


def test_missing_required_field_stable_code(load_fixture) -> None:
    with pytest.raises(ValidationError) as exc:
        normalize_record(make_record(load_fixture("missing_field.json")), **ARGS)
    assert exc.value.code == "validation_error"
    assert "stat_date" in str(exc.value)


def test_bad_date_shape_stable_code(load_fixture) -> None:
    with pytest.raises(ValidationError) as exc:
        normalize_record(make_record(load_fixture("bad_date.json")), **ARGS)
    assert exc.value.code == "validation_error"
    assert "YYYY-MM-DD" in str(exc.value)


def test_extreme_price_rejected(load_fixture) -> None:
    with pytest.raises(ValidationError) as exc:
        normalize_record(make_record(load_fixture("extreme_price.json")), **ARGS)
    assert exc.value.code == "validation_error"
    assert "极端价格" in str(exc.value)


def test_negative_sample_count_rejected() -> None:
    record = make_record(
        {"stat_date": "2026-11-01", "sample_count": -3, "total_price_yuan": 1000000}
    )
    with pytest.raises(ValidationError) as exc:
        normalize_record(record, **ARGS)
    assert exc.value.code == "validation_error"


def test_no_price_at_all_rejected() -> None:
    record = make_record({"stat_date": "2026-11-01", "sample_count": 1})
    with pytest.raises(ValidationError):
        normalize_record(record, **ARGS)


def test_invalid_enum_rejected() -> None:
    record = make_record(
        {"stat_date": "2026-11-01", "sample_count": 1, "total_price_yuan": 1000000}
    )
    with pytest.raises(ValidationError):
        normalize_record(record, price_type="rent_magic", metric_code="m", connector_version="1")
