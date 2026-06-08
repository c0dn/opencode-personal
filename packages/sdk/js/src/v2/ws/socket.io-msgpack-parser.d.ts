declare module "socket.io-msgpack-parser" {
  const parser: {
    Encoder: new () => unknown
    Decoder: new () => unknown
    protocol: number
  }
  export default parser
}
