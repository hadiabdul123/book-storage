# Local English text recognition

Tesseract.js 7.0.0 and its Tesseract.js-core dependency are installed through the committed npm lockfile. Engine licenses are copied from the packages into the public OCR directory during asset preparation.

English model: `@tesseract.js-data/eng` 1.0.0, `4.0.0_best_int/eng.traineddata.gz`.
SHA-256: `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`.
Source: https://github.com/naptha/tessdata (Apache 2.0 model license, included as DATA-LICENSE.txt). The npm wrapper declares MIT; the model is redistributed under its upstream Apache 2.0 license.

All worker, engine and model requests use the app's own origin. Recognition runs on one requested page at a time in a worker. No book image or text is submitted to an OCR API. Recognized word boxes are stored in the account-bound local database and cleared on sign-out. Only ordinary saved annotations use cloud sync. OCR can misread words and currently supports English.
