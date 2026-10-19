# OrthoViz

Desktop app that turns a cervical-spine CT scan (DICOM) into an understandable 3D model.
See [OrthoViz_Design_Doc.md](OrthoViz_Design_Doc.md).

```
app/       Electron shell + Three.js UI (not started)
backend/   Python backend: DICOM loading + TotalSegmentator segmentation
dicom_samples/  local RSNA test data (git-ignored)
output/    segmentation results from local runs (git-ignored)
```
