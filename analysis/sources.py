"""Read only the needed window of remote COG tiles, warped onto the analysis grid."""
import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling

import config as C


def read_warped(urls, crs, transform, width, height, resampling=Resampling.bilinear, dtype="float32", nodata=-9999):
    """Mosaic several tiles onto one grid; later tiles fill cells earlier ones left empty."""
    out = np.full((height, width), nodata, dtype=dtype)
    with rasterio.Env(**C.GDAL_ENV):
        for url in urls:
            try:
                src = rasterio.open(f"/vsicurl/{url}")
            except rasterio.errors.RasterioIOError:
                continue  # tile does not exist (e.g. open sea) → leave nodata
            with src, WarpedVRT(src, crs=crs, transform=transform, width=width, height=height,
                                resampling=resampling, nodata=nodata, dtype=dtype) as vrt:
                arr = vrt.read(1)
            fill = (out == nodata) & (arr != nodata)
            out[fill] = arr[fill]
    return out
