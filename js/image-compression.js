/**
 * Image compression utility
 */
const ImageCompression = {
    /**
     * Compress an image file to a target max width and quality.
     * @param {File} file - Image file to compress
     * @param {number} [maxWidth=1200] - Maximum width in pixels
     * @param {number} [quality=0.8] - JPEG/WebP quality (0-1)
     * @returns {Promise<Blob>} Compressed image blob
     */
    async compress(file, maxWidth = 1200, quality = 0.8) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = (maxWidth / width) * height;
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    resolve(blob);
                }, file.type, quality);
            };
            img.onerror = reject;
        });
    }
};

window.ImageCompression = ImageCompression;
