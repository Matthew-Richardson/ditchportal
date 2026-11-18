# La Plata County ditch damage portal

A mobile-friendly, static GitHub Pages app for residents to report irrigation ditch damage. Residents mark a spot or draw a stretch, attach photos, and review up to 10 reports before sending. The portal calculates the length of a traced stretch in feet. A spot report has no measured length.

The map reads [LPC Irrigation Ditches](https://gis.lpcgov.org/arcgis/rest/services/Operational_Layers/Hydrology/MapServer/5) and [LPC 2025 aerial imagery](https://gis.lpcgov.org/arcgis/rest/services/Orthos/WM2025Orthos2/MapServer). County aerial imagery is the default, with a maximum zoom level of 21. The ditch name and source object ID are suggested from the first marked location. Residents can correct the name or report an unmapped ditch. The ditch layer is reference geometry and stays separate from damage observations.

## Try the portal

Run `python -m http.server 8000` from this folder and open `http://localhost:8000/`. The portal checks both public intake views before enabling sending. Drafts are held in the current tab. Photos are resized to JPEG and their original filenames and metadata are omitted from the upload.

## 1. Create the ArcGIS Online source

Use a county ArcGIS Online account with hosted feature layer publishing privileges.

1. Run the following in the **ArcGIS Pro Python Command Prompt** from the repository folder. It creates an empty file geodatabase ZIP with both feature classes, Global IDs, and attachments.

   ```powershell
   python setup/build_intake_geodatabase.py LPC_Ditch_Damage.zip
   ```

2. In the organization's **Content → New item → Your device**, choose the ZIP and publish it as a hosted feature layer. Name the published item **LPC Ditch Damage**.
3. Keep the hosted source and uploaded ZIP private. Where staff need access, share the source with the appropriate county group. Use the source layer in Map Viewer or ArcGIS Pro to review submitted reports and photos.
4. Verify both layers have attachments and use `GlobalID` as the Global ID field. Enable editor tracking to record when a report was received. In the hosted service JSON, confirm `supportsApplyEditsWithGlobalIds: true` for both layers and service-level rollback support. If necessary, enable sync on the source to provide Global ID-based edits, if permitted by county settings, then recheck before proceeding.

Each report is an editable feature with attributes and attachments. Using a point sublayer and a polyline sublayer keeps both geometry types usable in ArcGIS Pro. The same `batch_id` ties them together.

| Field | Type | Purpose |
| --- | --- | --- |
| `GlobalID` | Global ID | Stable report ID, also used to link attachments |
| `batch_id` | Text, 38 | Submission reference shared by the batch |
| `damage_type` | Text, 80 | Resident-selected damage category |
| `ditch_name` | Text, 150 | Suggested or user-entered ditch name |
| `ditch_oid` | Long | Optional reference to LPC Irrigation Ditches `OBJECTID_1` |
| `length_ft` | Double | Estimated polyline length in feet |
| `damage_notes` | Text, 1500 | Required resident description |
| `ditch_operator` | Text, 200 | Ditch company, district, or operator |
| `observed_date` | Date | First observed date, stored as noon UTC on the selected day |
| `damage_cause` | Text, 120 | Suspected cause |
| `delivery_status` | Text, 60 | Water delivery status |
| `threat_notes` | Text, 1500 | What is still at risk |
| `acres_affected` | Double | Estimated irrigated acres affected |
| `repair_status` | Text, 80 | Repair status |
| `contact_name` | Text, 150 | Optional follow-up name |
| `contact_phone` | Text, 50 | Optional follow-up phone |
| `contact_email` | Text, 254 | Optional follow-up email |
| Geometry | WGS 84 | Point or traced polyline |

## 2. Configure the public intake views

1. On the private hosted feature layer item, choose **Create View Layer** for each geometry type and include the fields above. Keep attachments enabled in the view so they can be added in the same request as the parent features.
2. On each view's **Settings** tab, enable editing and select **Add** only. Under **What features can editors see?**, select **Editors can't see any features, even those they add**. With editor tracking enabled, select **Only add new features, if allowed above** under anonymous access.
3. Enable public data collection on the **view** and share it with **Everyone (public)**. Leave the source item restricted to the county.
4. The two Ditch Damage views are already configured in [config.js](config.js), each with layer ID `0`. If a service changes, update its `url` and `layerId` there. Verify both view layers support Global ID edits and that an anonymous count query is denied.

See [Esri's editing settings](https://doc.arcgis.com/en/arcgis-online/manage-data/manage-editing-hfl.htm), [attachment settings](https://doc.arcgis.com/en/arcgis-online/manage-data/manage-attachments-online.htm), and [service-level applyEdits](https://developers.arcgis.com/rest/services-reference/enterprise/apply-edits-feature-service/).

## 3. Publish and verify

1. Push the contents of this repository to the `main` branch in GitHub. In **Settings → Pages**, select **Deploy from a branch → main → / (root)**. The Pages URL is the public portal.
2. Open the portal in a signed-out browser. Submit one clearly labeled test batch with one spot, one stretch, and a photo on each. In the private source, verify both geometries, the approximate length in feet, the photos, and the matching batch reference.
3. While signed out, directly test the intake REST view for both layers. Verify a query, the known test feature's ID, its attachment listing and its known attachment URL reveal no report or photo, and that updates and deletes are denied. Verify the source URLs require authentication. Repeat the privacy check as a non-staff signed-in ArcGIS user. If any test fails, unshare the view while correcting its settings.
4. Verify an invalid edit rolls back the reports and photos sent to that view. Send one final valid test from a phone over cellular before distributing the URL.

The browser sends a service-level `applyEdits` request with rollback enabled for each geometry type present. With separate views, one request can succeed while the other fails. The portal removes confirmed reports from the queue and retries only the remaining reports using their original Global IDs. Staff can look up either geometry type by the shared `batch_id` if a receipt remains unconfirmed.
