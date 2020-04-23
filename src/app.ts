import express from 'express';
import aws from 'aws-sdk';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

aws.config.update({
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
    region: process.env['AWS_REGION']
})

const s3 = new aws.S3();
const pdfExportS3BucketName = process.env['AWS_S3_QUIZIO_EXPORTED_PDF_BUCKET_NAME'];
const sqs = new aws.SQS();
const queueURL = process.env['AWS_SQS_QUIZIO_EXPORT_QUEUE_URL'];

const sns = new aws.SNS();
const snsQuizioExportTopicARN = process.env['AWS_SNS_QUIZIO_EXPORT_TOPIC_ARC'];

//creates a PDF and returns the bytes in a Buffer
const doPdf = async (entryCodes) => {
    // Create a new PDFDocument
    const pdfDoc = await PDFDocument.create()

    // Embed the Times Roman font
    const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman)

    // Add a blank page to the document
    let page = pdfDoc.addPage()
    let currentPageIndex = 0;

    // Get the width and height of the page
    const { width, height } = page.getSize()
    const firstColumnX = 10;
    const secondColumnX = width / 2 + 10;
    const fontSize = 10;
    const margin = 5;
    const lineSize = fontSize + margin;

    const linesPerPage = Math.floor(height / lineSize);

    entryCodes.forEach((entryCode, index) => {
        if (index > 1 && (index % linesPerPage == 0)) {
            currentPageIndex++;
            page = pdfDoc.addPage();
        }
        page.drawText(`${index + 1}. ${entryCode.code}, ${entryCode.name || "No name set."}`, {
            x: firstColumnX,
            y: height - ((index % linesPerPage) + 1) * lineSize,
            size: fontSize,
            font: timesRomanFont,
            color: rgb(0, 0, 0),
        })
        page.drawText(`${entryCode.result}`, {
            x: secondColumnX,
            y: height - ((index % linesPerPage) + 1) * lineSize,
            size: fontSize,
            font: timesRomanFont,
            color: rgb(0, 0, 0),
        })
    })

    // Serialize the PDFDocument to bytes (a Uint8Array)
    const pdfBytes = await pdfDoc.save()
    return Buffer.from(pdfBytes);
}

//Uploads to the bucket and returns the pre-signed URL
const uploadToPDFBucketAndGetPreSignedURL = async (fileName, bufferData) => {
    await s3.putObject({
        Bucket: pdfExportS3BucketName,
        Key: fileName,
        Body: bufferData
    }).promise();
    //get a pre-signed (temporary) URL expiring after 1 minute
    const url = await s3.getSignedUrlPromise('getObject', {
        Bucket: pdfExportS3BucketName,
        Key: fileName,
        Expires: 60
    });
    return url;
}

const getUrlForEntryCodesPDF = async (entryCodes) => {
    const pdfBuffer = await doPdf(entryCodes);
    const url = await uploadToPDFBucketAndGetPreSignedURL(`${new Date().toISOString()}-export.pdf`, pdfBuffer);
    return url;
}

const pollFromSQS = async () => {
    console.log('Started polling from SQS.');
    var params = {
        AttributeNames: [
            "SentTimestamp"
        ],
        MaxNumberOfMessages: 1,
        MessageAttributeNames: [
            "All"
        ],
        QueueUrl: queueURL,
        WaitTimeSeconds: 20
    };
    while (true) {
        const result = await sqs.receiveMessage(params).promise().catch(() => console.log('Receiving message failed.'));
        if (result && result.Messages && result.Messages.length > 0) {
            const body = JSON.parse(result.Messages[0].Body);
            const pdfURL = await getUrlForEntryCodesPDF(body.data);
            sendMessageToSNSQuizioExportTopic(body.id, pdfURL);
            await sqs.deleteMessage({
                QueueUrl: queueURL,
                ReceiptHandle: result.Messages[0].ReceiptHandle
            }).promise().catch(() => { console.log('Deleting a message failed.') })
        }
    }
}

//Sends a string format message
const sendMessageToSNSQuizioExportTopic = (id, data) => {
    sns.publish({
        Message: JSON.stringify({ id, url: data }),
        TopicArn: snsQuizioExportTopicARN
    }).promise()
        .then(() => console.log('SNS message sent successfully.'))
        .catch(() => console.log('Something went wrong while sending SNS message to queue.'));
}

pollFromSQS();

const app = express();
const port = 3005

app.get('/', (req, res) => res.send('Hello World!'))

app.listen(port, () => console.log(`App listening at http://localhost:${port}`))