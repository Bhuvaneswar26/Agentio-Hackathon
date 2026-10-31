"""Configurable service taxonomy: category aliases, service-code tokens and description synonyms."""
from __future__ import annotations

import re

CATEGORY_ALIASES: dict[str, str] = {
    "ROOM": "ROOM_RENT", "ROOM_CHARGES": "ROOM_RENT", "ROOM_RENT": "ROOM_RENT", "ACCOMMODATION": "ROOM_RENT",
    "ICU": "ICU", "ICU_CHARGES": "ICU", "INTENSIVE_CARE": "ICU",
    "DIAGNOSTIC": "DIAGNOSTICS", "DIAGNOSTICS": "DIAGNOSTICS", "LAB": "DIAGNOSTICS", "INVESTIGATIONS": "DIAGNOSTICS",
    "PHARMACY": "PHARMACY", "MEDICINES": "PHARMACY", "DRUGS": "PHARMACY",
    "CONSUMABLE": "CONSUMABLES", "CONSUMABLES": "CONSUMABLES",
    "SURGERY": "SURGERY", "OT": "SURGERY", "OT_CHARGES": "SURGERY", "PROCEDURE": "SURGERY",
    "DOCTOR_FEES": "DOCTOR_FEES", "CONSULTATION": "DOCTOR_FEES", "PROFESSIONAL_FEES": "DOCTOR_FEES",
    "NURSING": "NURSING", "AMBULANCE": "AMBULANCE",
}

# First token of a service code -> category (exact token match avoids CONS/CONSULT clashes)
SERVICE_CODE_TOKENS: dict[str, str] = {
    "ROOM": "ROOM_RENT", "ICU": "ICU", "DIAG": "DIAGNOSTICS", "LAB": "DIAGNOSTICS", "RAD": "DIAGNOSTICS",
    "PHARM": "PHARMACY", "MED": "PHARMACY", "CONS": "CONSUMABLES", "CONSUMABLE": "CONSUMABLES",
    "SURG": "SURGERY", "OT": "SURGERY", "DOC": "DOCTOR_FEES", "CONSULT": "DOCTOR_FEES",
    "NURS": "NURSING", "AMB": "AMBULANCE",
}

# Evaluated in priority order (ICU before ROOM so "ICU room charges" is ICU)
CATEGORY_SYNONYMS: dict[str, list[str]] = {
    "ICU": ["icu", "intensive care", "critical care", "iccu", "nicu"],
    "SURGERY": ["surgery", "surgical", "operation theatre", "operation theater", "ot charges", "anaesthesia",
                "anesthesia", "procedure charges"],
    "CONSUMABLES": ["consumable", "consumables", "gloves", "syringe", "disposable", "gown", "mask"],
    "DIAGNOSTICS": ["diagnostic", "laboratory", "lab test", "blood test", "pathology", "x ray", "xray", "mri",
                    "ct scan", "ultrasound", "radiology", "ecg", "scan"],
    "PHARMACY": ["pharmacy", "medicine", "medicines", "drugs", "medication", "injection", "tablet"],
    "DOCTOR_FEES": ["doctor fee", "doctor fees", "consultation", "consultant", "visiting charges", "surgeon fee",
                    "physician"],
    "NURSING": ["nursing", "nurse"],
    "AMBULANCE": ["ambulance"],
    "ROOM_RENT": ["room charges", "room rent", "room", "bed charges", "ward charges", "accommodation"],
}

PER_DAY_CATEGORIES = {"ROOM_RENT", "ICU", "NURSING"}


def normalize_category(raw: str | None) -> str | None:
    if raw is None or not str(raw).strip():
        return None
    key = re.sub(r"[^A-Z0-9]+", "_", str(raw).upper()).strip("_")
    return CATEGORY_ALIASES.get(key, key)
