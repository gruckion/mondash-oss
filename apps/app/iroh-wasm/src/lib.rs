use futures_util::future::{AbortHandle, Abortable};
use iroh::{Endpoint, RelayMode, SecretKey, TransportAddr, endpoint::{Connection, RecvStream, presets}};
use iroh_tickets::endpoint::EndpointTicket;
use std::{cell::{Cell, RefCell}, rc::Rc, str::FromStr};
use wasm_bindgen::prelude::*;

fn error(value: impl std::fmt::Display) -> JsValue { JsValue::from_str(&value.to_string()) }
fn address(ticket: &str) -> Result<iroh::EndpointAddr, JsValue> {
    let ticket = EndpointTicket::from_str(ticket).map_err(error)?;
    let mut address = ticket.endpoint_addr().clone();
    let mut relays = Vec::new();
    for transport in &address.addrs {
        if let TransportAddr::Relay(relay) = transport {
            let mut url = url::Url::parse(relay.as_str()).map_err(error)?;
            let host = url.host_str().ok_or_else(|| error("Missing relay host"))?.trim_end_matches('.').to_owned();
            url.set_host(Some(&host)).map_err(error)?;
            relays.push(TransportAddr::Relay(iroh::RelayUrl::from(url)));
        }
    }
    if relays.is_empty() { return Err(error("The Mac invitation needs a relay address")); }
    address.addrs = relays.into_iter().collect();
    Ok(address)
}

#[wasm_bindgen]
pub fn ticket_identity(ticket: String) -> Result<String, JsValue> { Ok(address(&ticket)?.id.to_string()) }

#[wasm_bindgen]
pub struct BrowserEndpoint { endpoint: Endpoint }
#[wasm_bindgen]
impl BrowserEndpoint {
    pub async fn bind(secret: Vec<u8>, ticket: String) -> Result<BrowserEndpoint, JsValue> {
        console_error_panic_hook::set_once();
        let bytes: [u8; 32] = secret.try_into().map_err(|_| error("Invalid browser identity"))?;
        let relays = address(&ticket)?.addrs.into_iter().filter_map(|a| match a { TransportAddr::Relay(url) => Some(url), _ => None }).collect::<Vec<_>>();
        let endpoint = Endpoint::builder(presets::Minimal).secret_key(SecretKey::from_bytes(&bytes)).relay_mode(RelayMode::custom(relays)).bind().await.map_err(error)?;
        Ok(Self { endpoint })
    }
    pub fn identity(&self) -> String { self.endpoint.id().to_string() }
    pub async fn close(&self) { self.endpoint.close().await; }
}

struct State {
    closed: Cell<bool>,
    reading: Cell<bool>,
    connection: RefCell<Option<Connection>>,
    recv: RefCell<Option<RecvStream>>,
    abort: RefCell<Option<AbortHandle>>,
}
#[wasm_bindgen]
pub struct BrowserRequest { endpoint: Endpoint, state: Rc<State> }
#[wasm_bindgen]
impl BrowserRequest {
    #[wasm_bindgen(constructor)]
    pub fn new(endpoint: &BrowserEndpoint) -> BrowserRequest {
        Self { endpoint: endpoint.endpoint.clone(), state: Rc::new(State { closed: Cell::new(false), reading: Cell::new(false), connection: RefCell::new(None), recv: RefCell::new(None), abort: RefCell::new(None) }) }
    }
    pub async fn open(&self, ticket: String, frame: String) -> Result<(), JsValue> {
        if self.state.closed.get() || self.state.connection.borrow().is_some() { return Err(error("Request closed or already opened")); }
        if frame.len() > 5_000_000 { return Err(error("Request too large")); }
        let address = address(&ticket)?;
        let expected = address.id;
        let (abort, registration) = AbortHandle::new_pair();
        *self.state.abort.borrow_mut() = Some(abort);
        let result = Abortable::new(async {
            let connection = self.endpoint.connect(address, b"mondash-experiment/http/1").await.map_err(error)?;
            if connection.remote_id() != expected { connection.close(1u32.into(), b"identity mismatch"); return Err(error("Mac identity mismatch")); }
            if self.state.closed.get() { connection.close(0u32.into(), b"cancelled"); return Err(error("Request cancelled")); }
            *self.state.connection.borrow_mut() = Some(connection.clone());
            let (mut send, recv) = connection.open_bi().await.map_err(error)?;
            send.write_all(frame.as_bytes()).await.map_err(error)?;
            send.finish().map_err(error)?;
            *self.state.recv.borrow_mut() = Some(recv);
            Ok(())
        }, registration).await.map_err(|_| error("Request cancelled"))?;
        self.state.abort.borrow_mut().take();
        result
    }
    pub async fn read(&self, limit: u32) -> Result<Vec<u8>, JsValue> {
        if self.state.closed.get() || self.state.reading.replace(true) { return Err(error("Request closed or already reading")); }
        let Some(mut recv) = self.state.recv.borrow_mut().take() else { self.state.reading.set(false); return Err(error("Request not open")); };
        let (abort, registration) = AbortHandle::new_pair();
        *self.state.abort.borrow_mut() = Some(abort);
        let mut bytes = vec![0u8; limit.clamp(1, 65536) as usize];
        let result = Abortable::new(recv.read(&mut bytes), registration).await;
        self.state.abort.borrow_mut().take();
        self.state.reading.set(false);
        if !self.state.closed.get() { *self.state.recv.borrow_mut() = Some(recv); }
        let size = result.map_err(|_| error("Request cancelled"))?.map_err(error)?.unwrap_or(0);
        bytes.truncate(size);
        Ok(bytes)
    }
    pub fn cancel(&self) {
        self.state.closed.set(true);
        if let Some(abort) = self.state.abort.borrow_mut().take() { abort.abort(); }
        if let Some(connection) = self.state.connection.borrow_mut().take() { connection.close(0u32.into(), b"cancelled"); }
        if let Some(mut recv) = self.state.recv.borrow_mut().take() { let _ = recv.stop(0u32.into()); }
    }
}
