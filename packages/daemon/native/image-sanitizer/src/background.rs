// Match ui-react/backgroundOutputDimensions. This preset is only used by explicit wallpaper imports.
pub(crate) fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = 1.0_f64
        .min(2560.0 / width.max(height) as f64)
        .min((4_000_000.0 / (width as f64 * height as f64)).sqrt());
    (
        ((width as f64 * scale).floor() as u32).max(1),
        ((height as f64 * scale).floor() as u32).max(1),
    )
}

pub(crate) fn resize(width: u32, height: u32, pixels: Vec<u8>) -> (u32, u32, Vec<u8>) {
    let (out_width, out_height) = dimensions(width, height);
    if (width, height) == (out_width, out_height) {
        return (width, height, pixels);
    }
    let mut output = vec![0; out_width as usize * out_height as usize * 4];
    let scale_x = width as f64 / out_width as f64;
    let scale_y = height as f64 / out_height as f64;
    // Area averaging avoids aliasing; premultiplied alpha avoids dark fringes at transparent edges.
    // Every source area is visited at most a few times; work is bounded by the input pixel limit.
    for y in 0..out_height {
        let top = y as f64 * scale_y;
        let bottom = (y + 1) as f64 * scale_y;
        for x in 0..out_width {
            let left = x as f64 * scale_x;
            let right = (x + 1) as f64 * scale_x;
            let mut rgba = [0.0; 4];
            for sy in top.floor() as u32..(bottom.ceil() as u32).min(height) {
                let wy = (bottom.min((sy + 1) as f64) - top.max(sy as f64)).max(0.0);
                for sx in left.floor() as u32..(right.ceil() as u32).min(width) {
                    let weight = wy * (right.min((sx + 1) as f64) - left.max(sx as f64)).max(0.0);
                    let index = (sy as usize * width as usize + sx as usize) * 4;
                    let alpha = pixels[index + 3] as f64;
                    for channel in 0..3 {
                        rgba[channel] += pixels[index + channel] as f64 * alpha * weight;
                    }
                    rgba[3] += alpha * weight;
                }
            }
            let index = (y as usize * out_width as usize + x as usize) * 4;
            if rgba[3] > 0.0 {
                for channel in 0..3 {
                    output[index + channel] =
                        (rgba[channel] / rgba[3]).round().clamp(0.0, 255.0) as u8;
                }
            }
            output[index + 3] = (rgba[3] / (scale_x * scale_y)).round().clamp(0.0, 255.0) as u8;
        }
    }
    (out_width, out_height, output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_portrait_panorama_and_no_upscale() {
        for (input, expected) in [
            ((4096, 2304), (2560, 1440)),
            ((4000, 4000), (2000, 2000)),
            ((2304, 4096), (1440, 2560)),
            ((8192, 1), (2560, 1)),
            ((3, 2), (3, 2)),
        ] {
            assert_eq!(dimensions(input.0, input.1), expected);
        }
    }
    #[test]
    fn transparent_pixels_do_not_pollute_color_when_downsampling() {
        let mut pixels = Vec::new();
        for _ in 0..2560 {
            pixels.extend_from_slice(&[255, 0, 0, 255, 0, 0, 255, 0]);
        }
        let (w, h, out) = resize(5120, 1, pixels);
        assert_eq!((w, h), (2560, 1));
        for pixel in out.chunks_exact(4) {
            assert_eq!(pixel, [255, 0, 0, 128]);
        }
    }
}
