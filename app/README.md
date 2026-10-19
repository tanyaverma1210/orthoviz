# OrthoViz — Electron app (not built yet)

This folder will hold the Electron shell and the Three.js UI (design doc §3, §9):
import screen, processing screen, and 3D viewer.

The app will run the Python backend in [`../backend`](../backend) as a local
subprocess/server and render its output (`segmentation.nii.gz` + `labels.json`).
