import { NextResponse } from 'next/server';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { PDFLoader } from 'langchain/document_loaders/fs/pdf';
import prisma from '../../lib/prisma';
import { getAuth } from '@clerk/nextjs/server';
import { loadEmbeddingsModel } from '../utils/embeddings';
import { loadVectorStore } from '../utils/vector_store';
import axios from 'axios';

export async function POST( request: Request) {
  const { fileUrl, fileName } = await request.json();

  const { userId } = getAuth(request as any);

  if (!userId) {
    return NextResponse.json({ error: 'You must be logged in to ingest data' });
  }

  const docAmount = await prisma.document.count({
    where: {
      userId,
    },
  });

  if (docAmount > 3) {
    return NextResponse.json({
      error: 'You have reached the maximum number of documents',
    });
  }

  const doc = await prisma.document.create({
    data: {
      fileName,
      fileUrl,
      userId,
    },
  });

  const namespace = doc.id;

  try {
    // Load from remote pdf URL using axios:
    const response = await axios.get(fileUrl, { responseType: 'blob'});
    const buffer = response.data;
    const loader = new PDFLoader(buffer);
    const rawDocs = await loader.load();

    /* Split text into chunks */
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const splitDocs = await textSplitter.splitDocuments(rawDocs);
    // Necessary for Mongo - we'll query on this later.
    for (const splitDoc of splitDocs) {
      splitDoc.metadata.docstore_document_id = namespace;
    }

    console.log('Creating vector store...');

    // Create and store the embeddings in the vector store:
    const embeddings = loadEmbeddingsModel();

    const store = await loadVectorStore({
      namespace: doc.id,
      embeddings,
    });
    const vectorstore = store.vectorstore;

    // Embed the PDF documents:
    await vectorstore.addDocuments(splitDocs);
  } catch (error) {
    console.log('error', error);
    return NextResponse.json({ error: 'Failed to ingest your data' });
  }

  return NextResponse.json({
    text: 'Successfully embedded pdf',
    id: namespace,
  });
}