from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
import pytest
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

from orthoviz_backend.dicom_loader import DicomLoadError, load_dicom_folder

SAMPLES = Path(__file__).resolve().parents[2] / "dicom_samples"


def _write_slice(path: Path, z: float, value: int, series_uid: str, study_uid: str,
                 instance: int, rows=4, cols=3) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.InstanceNumber = instance
    ds.ImagePositionPatient = [-10.0, -20.0, z]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.PixelSpacing = [0.5, 0.7]  # [between rows, between columns]
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.RescaleSlope, ds.RescaleIntercept = 1, -1024
    pixels = np.full((rows, cols), value, dtype=np.uint16)
    pixels[0, 1] = value + 100  # marker: row 0, column 1
    ds.PixelData = pixels.tobytes()
    ds.save_as(path, enforce_file_format=True)


@pytest.fixture
def synthetic_series(tmp_path):
    study, series = generate_uid(), generate_uid()
    # Written with instance numbers and filenames deliberately out of spatial order.
    for i, z in enumerate([4.0, 0.0, 2.0, 6.0]):
        _write_slice(tmp_path / f"{i}.dcm", z, value=1000 + int(z), series_uid=series,
                     study_uid=study, instance=i + 1)
    (tmp_path / ".DS_Store").write_bytes(b"junk")
    (tmp_path / "notes.txt").write_text("not dicom")
    return tmp_path


def test_synthetic_series_geometry_and_values(synthetic_series):
    vol = load_dicom_folder(synthetic_series)
    data = np.asarray(vol.image.dataobj)

    assert data.shape == (3, 4, 4)  # (columns, rows, slices)
    assert vol.spacing_mm == pytest.approx((0.7, 0.5, 2.0))
    assert vol.warnings == []
    # Slices sorted by z, HU rescale applied.
    assert [int(data[0, 1, k]) for k in range(4)] == [-24, -22, -20, -18]
    # Marker at DICOM (row 0, col 1) lands at voxel i=1, j=0.
    assert data[1, 0, 0] == data[0, 0, 0] + 100
    # Origin converted from LPS (-10, -20, 0) to RAS.
    assert vol.image.affine[:3, 3] == pytest.approx([10.0, 20.0, 0.0])
    assert nib.aff2axcodes(vol.image.affine) == ("L", "P", "S")


def test_irregular_spacing_warns(tmp_path):
    study, series = generate_uid(), generate_uid()
    for i, z in enumerate([0.0, 1.0, 2.0, 5.0]):
        _write_slice(tmp_path / f"{i}.dcm", z, 0, series, study, i + 1)
    assert load_dicom_folder(tmp_path).warnings


def test_duplicate_slices_rejected(tmp_path):
    study, series = generate_uid(), generate_uid()
    for i, z in enumerate([0.0, 1.0, 1.0]):
        _write_slice(tmp_path / f"{i}.dcm", z, 0, series, study, i + 1)
    with pytest.raises(DicomLoadError, match="duplicate"):
        load_dicom_folder(tmp_path)


def test_empty_folder_rejected(tmp_path):
    with pytest.raises(DicomLoadError):
        load_dicom_folder(tmp_path)


@pytest.mark.skipif(not (SAMPLES / "patient1").is_dir(), reason="sample data not present")
def test_rsna_sample_loads():
    vol = load_dicom_folder(SAMPLES / "patient1")
    assert vol.image.shape == (512, 512, 429)
    assert vol.spacing_mm == pytest.approx((0.28515625, 0.28515625, 0.5))
    assert vol.study_uid == "1.2.826.0.1.3680043.10633"
