"""Build the empty ArcGIS Online intake schema in the ArcGIS Pro Python environment."""

import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

import arcpy


LAYERS = (("Damage_Points", "POINT"), ("Damage_Stretches", "POLYLINE"))
FIELDS = (
    ("batch_id", "TEXT", "Submission reference", 38),
    ("damage_type", "TEXT", "Damage type", 80),
    ("ditch_name", "TEXT", "Ditch name", 150),
    ("ditch_oid", "LONG", "LPC irrigation ditches object ID", None),
    ("length_ft", "DOUBLE", "Estimated damage length (feet)", None),
    ("damage_notes", "TEXT", "Damage description", 1500),
    ("ditch_operator", "TEXT", "Ditch company, district, or operator", 200),
    ("observed_date", "DATE", "Date damage was first observed", None),
    ("damage_cause", "TEXT", "Suspected cause of damage", 120),
    ("delivery_status", "TEXT", "Water delivery status", 60),
    ("threat_notes", "TEXT", "What is still at risk", 1500),
    ("acres_affected", "DOUBLE", "Estimated irrigated acres affected", None),
    ("repair_status", "TEXT", "Repair status", 80),
    ("contact_name", "TEXT", "Contact name", 150),
    ("contact_phone", "TEXT", "Contact phone", 50),
    ("contact_email", "TEXT", "Contact email", 254),
)


def create_schema(directory):
    arcpy.management.CreateFileGDB(str(directory), "LPC_Ditch_Damage.gdb")
    geodatabase = directory / "LPC_Ditch_Damage.gdb"
    for name, geometry in LAYERS:
        arcpy.management.CreateFeatureclass(
            str(geodatabase), name, geometry, spatial_reference=arcpy.SpatialReference(4326)
        )
        feature_class = str(geodatabase / name)
        for field_name, field_type, alias, length in FIELDS:
            options = {"field_length": length} if length else {}
            arcpy.management.AddField(
                feature_class, field_name, field_type, field_alias=alias, **options
            )
        arcpy.management.AddGlobalIDs(feature_class)
        arcpy.management.EnableAttachments(feature_class)
        arcpy.management.EnableEditorTracking(
            feature_class, "created_user", "created_date", "last_edited_user", "last_edited_date",
            "ADD_FIELDS", "UTC",
        )
    arcpy.management.ClearWorkspaceCache()
    return geodatabase


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_zip", type=Path, help="New .zip file to publish in ArcGIS Online")
    args = parser.parse_args()
    target = args.output_zip.resolve()
    if target.suffix.lower() != ".zip":
        parser.error("output_zip must end with .zip")
    if target.exists():
        parser.error(f"Output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as work:
        geodatabase = create_schema(Path(work))
        with ZipFile(target, "x", compression=ZIP_DEFLATED) as archive:
            for file in sorted(geodatabase.rglob("*")):
                if file.is_file() and file.suffix.lower() != ".lock":
                    archive.write(file, file.relative_to(geodatabase.parent))
    print(f"Created {target}")


if __name__ == "__main__":
    main()
